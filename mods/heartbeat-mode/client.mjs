// client.mjs — 心动模式。
//
// 开启后播队列由这个模组安排：「随机一首我喜欢的音乐 + 两首推荐」一组接一组，永远循环下去，不会
// 落回原歌单顺序。做法是接管整条队列（`folium.playback.replaceQueue`，公开接口，权限
// `playback.queue`）：
//
//   队列 = [正在放的这首, 喜欢, 推荐, 推荐, 喜欢, 推荐, 推荐, …]
//
// 为什么不往用户原队列里插歌：抽到的「喜欢」在用户歌单里本来就有副本，插进去以后队列里同一个
// 身份出现两次，宿主按「第一次出现」定位当前歌，下一首就顺着原歌单走了 —— 这是 1.3 之前的 bug。
// 接管之后队列里只有模组放进去的歌，物理上不可能回到原顺序。
//
// 用户原来的队列存一份快照（本会话用歌曲 DTO，跨会话用可移植身份），退出时还原。
//
// 接口全部是 Folium 1.7 的公开成员：没有 internals、没有 localStorage、不读宿主凭据。

import { songKey, uniqueSongs, countAhead, rotateFrom } from './queue.mjs';
import { createSource } from './recommend.mjs';

const RUNWAY_TARGET = 6;         // 当前歌后面至少留这么多首（两组）由模组安排
const GROUPS_PER_REFILL = 2;     // 一次补几组
const RECS_PER_GROUP = 2;
const LIKED_CANDIDATES = 12;     // 一次解析多少首候选「喜欢」
const MAX_REC_ATTEMPTS = 3;      // 一组推荐最多试几轮
const DRY_COOLDOWN_MS = 30000;   // 一轮都补不上时的冷却
const MIN_REPLACE_GAP_MS = 1100; // 宿主对 replaceQueue 有每秒一次的限制
const PAGE_LIMIT = 500;          // getQueue 一页最多 500 首
const STORAGE_KEY = 'queue-snapshot';
const RESTORE_WAIT_MS = 15000;   // 开机时等宿主把队列恢复出来

const SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pairOf = (song) => [String(song.source ?? ''), String(song.id ?? '')];
const pairsOf = (songs) => songs.map(pairOf);
const keyOfPair = (pair) => `${pair?.[0] ?? ''}\u0000${pair?.[1] ?? ''}`;

/** 提示文案。 */
const say = {
    needSong: '先放一首歌，再开启心动模式',
    needLogin: '先在 Folia 里登录网易云，心动模式要用到「我喜欢的音乐」',
    preparing: '正在准备心动模式…（再点一次取消）',
    ready: '心动模式已开启：一首喜欢的歌 + 两首推荐，之后一直循环下去',
    cancelled: '已取消',
    stopped: '已退出心动模式，恢复开启前的队列',
    stoppedPartial: (missed) => `已退出心动模式，有 ${missed} 首歌没能放回队列`,
    singleLoop: '播放器现在是「单曲循环」，心动模式不会自动切歌；请在播放器里切成列表循环',
    unsupported: '这个版本的 Folia 还不支持心动模式需要的接口（需要 0.7.22 以上）',
    offline: '网易云没有响应，稍后再试',
    failed: '心动模式没能开启，稍后再试',
};

/**
 * 把失败翻译成一句能看懂的话：模组自己的错误绝不让它带着 `client activate:` 之类的
 * 前缀甩到用户脸上。
 */
const explain = (error) => {
    const code = error?.code ?? error?.message ?? '';
    if (typeof code !== 'string') return say.failed;
    if (code.startsWith('permission-denied')) return say.unsupported;
    switch (code) {
        case 'not-signed-in':
        case 'session-expired':
            return say.needLogin;
        case 'network':
        case 'rate-limited':
        case 'vip-required':
            return say.offline;
        case 'unsupported':
        case 'endpoint-denied':
            return say.unsupported;
        default:
            return say.failed;
    }
};

export default async function activate(folium) {
    // 需要 Folium 1.7（Folia 0.7.22 起）。老宿主上什么也不做，免得注册出一个按了没反应的按钮。
    const minor = Number(folium.host?.folium?.minor ?? 0);
    if (Number(folium.host?.folium?.major ?? 1) !== 1 || minor < 7) {
        folium.log?.warn?.('心动模式需要 Folium 1.7（Folia 0.7.22 以上）');
        return;
    }

    const playback = folium.playback;
    const source = createSource({
        folium,
        log: (message, detail) => folium.log?.info?.(`recommend: ${message}`, detail),
    });

    /** 当前会话。`null` = 没开。 */
    let session = null;
    let disposed = false;      // 返回的清理函数跑过之后：这个实例不再碰任何东西
    let busy = false;          // keepRunway 单飞
    let lastReplaceAt = 0;
    const painters = new Set();

    const paint = () => {
        for (const painter of painters) {
            try { painter(); } catch { /* 按钮已经被移除 */ }
        }
    };

    const toast = (message, type = 'info') => {
        try { folium.ui.toast(message, { type }); } catch { /* 导出窗口里没有 toast */ }
    };

    // ---------------------------------------------------------------- 队列读写

    /** 整条队列（分页读完）。队列在两次读之间变了就重读，最多三轮。 */
    const readQueue = () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const head = playback.getQueue({ offset: 0, limit: PAGE_LIMIT });
            const items = [...head.items];
            const version = head.version;
            let broke = false;
            while (items.length < head.length) {
                const page = playback.getQueue({ offset: items.length, limit: PAGE_LIMIT });
                if (page.version !== version || page.items.length === 0) { broke = true; break; }
                items.push(...page.items);
            }
            if (!broke) return { items, length: head.length, currentIndex: head.currentIndex, kind: head.kind, version };
        }
        return null;
    };

    /**
     * 整条替换队列。宿主的 replaceQueue 有版本校验、每秒一次的限制和几种拒绝理由，这里都接住：
     * `stale-version` 交回给调用方重读，`rate-limited` 等一会儿再试，其余放弃。
     */
    const replaceQueue = async (songs, version) => {
        const gap = Date.now() - lastReplaceAt;
        if (gap < MIN_REPLACE_GAP_MS) await SLEEP(MIN_REPLACE_GAP_MS - gap);
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const result = await playback.replaceQueue(songs, { expectedVersion: version });
            lastReplaceAt = Date.now();
            if (result?.status === 'replaced') return result;
            if (result?.reason === 'rate-limited') {
                await SLEEP(Math.max(MIN_REPLACE_GAP_MS, Number(result.retryAfterMs) || MIN_REPLACE_GAP_MS));
                continue;
            }
            return result;
        }
        return { status: 'refused', reason: 'rate-limited' };
    };

    // ---------------------------------------------------------------- 快照

    const saveSnapshot = async (record) => {
        try { await folium.storage.set(STORAGE_KEY, record); } catch (error) { folium.log?.warn?.('快照没写进去', error); }
    };
    const loadSnapshot = async () => {
        try { return await folium.storage.get(STORAGE_KEY); } catch { return undefined; }
    };
    const clearSnapshot = async () => {
        try { await folium.storage.delete(STORAGE_KEY); } catch { /* 已经没有了 */ }
    };

    /** 把当前会话的原队列写进 storage：跨会话还原要用。 */
    const persistSnapshot = (s) => saveSnapshot({
        version: 1,
        anchor: s.anchorSong ? pairOf(s.anchorSong) : null,
        songs: s.snapshotPairs,
        owned: [...s.ownedKeys].map((key) => key.split('\u0000')),
        savedAt: Date.now(),
    });

    /** 一批可移植身份 → 歌曲 DTO（认不出的丢掉）。 */
    const resolvePairs = async (pairs) => {
        const keys = (Array.isArray(pairs) ? pairs : [])
            .filter((pair) => Array.isArray(pair) && pair[0] && pair[1])
            .map((pair) => ({ source: pair[0], id: pair[1] }));
        const songs = [];
        for (let at = 0; at < keys.length; at += 50) {
            const answers = await folium.omni.resolveSongs(keys.slice(at, at + 50));
            for (const answer of answers) {
                if (answer?.status === 'found' && answer.song) songs.push(answer.song);
            }
        }
        return songs;
    };

    /** 当前这首 + 原队列里 anchor 之后的部分：退出时用这个还原。 */
    const queueFromOriginal = (originalSongs, anchorSong, currentSong) => {
        const ordered = rotateFrom(originalSongs, anchorSong);
        const current = currentSong ?? playback.getState().song;
        const rest = ordered.filter((song) => !current || songKey(song) !== songKey(current));
        return uniqueSongs([...(current ? [current] : []), ...rest]);
    };

    // ---------------------------------------------------------------- 推荐

    const emptyDraft = () => ({
        seen: new Set(),
        likedSeen: new Set(),
        recSeen: new Set(),
        triedLiked: new Set(),
    });

    /** 随机抽一首还没用过的「喜欢」，整张歌单都用过一轮了就清掉自己的记忆重来。 */
    const nextLikedSong = async (s, signal) => {
        const ids = s.likedIds ?? await source.likedIds(signal);
        s.likedIds = ids;
        if (ids.length === 0) return null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const fresh = ids.filter((id) => !s.draft.triedLiked.has(id));
            if (fresh.length === 0) {
                s.draft.triedLiked.clear();
                s.draft.likedSeen.clear();
            }
            const pool = fresh.length > 0 ? fresh : ids;
            const picks = [];
            while (picks.length < Math.min(LIKED_CANDIDATES, pool.length)) {
                const candidate = pool[Math.floor(Math.random() * pool.length)];
                if (!picks.includes(candidate)) picks.push(candidate);
            }
            if (picks.length === 0) return null;
            for (const id of picks) s.draft.triedLiked.add(id);
            const songs = await source.songsByIds(picks, signal);
            const usable = songs.find((song) => !s.draft.seen.has(songKey(song)));
            if (usable) return usable;
        }
        return null;
    };

    /** 一组：一首喜欢 + 两首推荐。推荐拿不到时先用喜欢的歌顶上，别让循环断掉。 */
    const nextGroup = async (s, signal) => {
        const seed = await nextLikedSong(s, signal);
        if (!seed) return null;
        const exclude = new Set([...s.draft.seen, songKey(seed)]);
        const recs = [];
        for (let attempt = 0; attempt < MAX_REC_ATTEMPTS && recs.length < RECS_PER_GROUP; attempt += 1) {
            const { songs } = await source.recommend(seed.id, RECS_PER_GROUP - recs.length, exclude, signal);
            for (const song of songs) {
                exclude.add(songKey(song));
                recs.push(song);
            }
        }
        if (recs.length === 0) return null; // 一首推荐都要不到：宁可不开启，也不要只有喜欢的歌在单曲循环
        const songs = uniqueSongs([seed, ...recs], s.draft.seen);
        return songs.length > 1 ? { songs } : null;
    };

    // ---------------------------------------------------------------- 补跑道

    /** 把一组歌接到当前歌后面（丢掉已经放过的历史，队列不会越滚越长）。 */
    const appendGroup = async (s, songs) => {
        const queue = readQueue();
        if (!queue || queue.kind !== 'queue') return false;
        const current = queue.currentIndex >= 0
            ? queue.items[queue.currentIndex].song
            : playback.getState().song;
        const ahead = (queue.currentIndex >= 0
            ? queue.items.slice(queue.currentIndex + 1)
            : queue.items).map((item) => item.song);
        const present = new Set([...(current ? [songKey(current)] : []), ...ahead.map(songKey)]);
        const fresh = songs.filter((song) => !present.has(songKey(song)));
        if (fresh.length === 0) return false;
        const next = uniqueSongs([...(current ? [current] : []), ...ahead, ...fresh]);
        const result = await replaceQueue(next, queue.version);
        if (result?.status === 'replaced') {
            for (const song of fresh) s.ownedKeys.add(songKey(song));
            await persistSnapshot(s);   // 崩溃/关机之后才能把每一首模组放进去的歌都认出来
            return true;
        }
        if (result?.reason === 'stale-version') return false; // 下一轮重读再来
        folium.log?.warn?.(`replaceQueue 被拒绝：${result?.reason ?? 'unknown'}`);
        return false;
    };

    const keepRunway = async () => {
        const s = session;
        if (!s || s.phase !== 'active' || busy || s.cancelled || disposed) return;
        if (Date.now() < s.dryUntil) return;
        busy = true;
        try {
            for (let round = 0; round < GROUPS_PER_REFILL; round += 1) {
                if (session !== s || s.cancelled) return;
                const queue = readQueue();
                if (!queue || queue.kind !== 'queue') return;
                if (countAhead(queue.items, queue.currentIndex) >= RUNWAY_TARGET) return;
                const group = await nextGroup(s).catch((error) => {
                    if (error?.code === 'aborted') return null;
                    folium.log?.warn?.('取一组推荐失败', error);
                    return null;
                });
                if (!group) {
                    s.dryUntil = Date.now() + DRY_COOLDOWN_MS;
                    return;
                }
                for (const song of group.songs) s.draft.seen.add(songKey(song));
                const ok = await appendGroup(s, group.songs);
                if (!ok) return;
            }
        } finally {
            busy = false;
        }
    };

    // ---------------------------------------------------------------- 会话

    const restoreOriginal = async (s) => {
        const current = playback.getState().song;
        const original = s.originalSongs?.length ? s.originalSongs : await resolvePairs(s.snapshotPairs);
        await clearSnapshot();
        if (original.length === 0) {
            toast(say.stopped, 'success');
            return;
        }
        const next = queueFromOriginal(original, s.anchorSong ?? current, current);
        const queue = readQueue();
        const result = queue ? await replaceQueue(next, queue.version) : { status: 'refused' };
        if (result?.status === 'replaced') toast(say.stopped, 'success');
        else toast(say.stoppedPartial(Math.max(1, original.length - next.length)), 'error');
    };

    const endSession = (s, restore) => {
        if (session !== s) return;
        session = null;
        s.cancelled = true;
        paint();
        if (!restore) { void clearSnapshot(); return; }
        void restoreOriginal(s).catch((error) => {
            folium.log?.warn?.('还原队列失败', error);
            void clearSnapshot();
        });
    };

    const cancelPreparing = (s) => {
        if (session !== s) return;
        session = null;
        s.cancelled = true;
        paint();
        void clearSnapshot();
        toast(say.cancelled, 'info');
    };

    /** 准备：读队列快照、抽喜欢的歌、要推荐、整条换上。 */
    const prepare = async (s) => {
        if (playback.getLoopMode() === 'one') toast(say.singleLoop, 'info');
        const state = playback.getState();
        s.anchorSong = state.song;
        const queue = readQueue();
        if (!queue || queue.kind === 'stage') {
            throw Object.assign(new Error('queue unusable'), { code: 'unsupported' });
        }
        s.originalSongs = queue.items.map((item) => item.song);
        s.snapshotPairs = pairsOf(s.originalSongs);

        const group = await nextGroup(s);
        if (s.cancelled || session !== s) return;
        if (!group) {
            const liked = await source.likedIds().catch((error) => {
                throw error;
            });
            throw Object.assign(new Error('no group'), {
                code: Array.isArray(liked) && liked.length === 0 ? 'not-signed-in' : 'network',
            });
        }

        const current = state.song;
        const nextQueue = uniqueSongs([current, ...group.songs]);
        const result = await replaceQueue(nextQueue, queue.version);
        if (s.cancelled || session !== s) {
            // 取消正好落在替换之后：立刻把原队列放回去，别让用户停在一个半成品队列上。
            const now = readQueue();
            if (result?.status === 'replaced' && now) {
                await replaceQueue(queueFromOriginal(s.originalSongs, s.anchorSong, playback.getState().song), now.version);
            }
            return;
        }
        if (result?.status !== 'replaced') {
            throw Object.assign(new Error('replace refused'), { code: 'unsupported' });
        }
        for (const song of group.songs) {
            s.draft.seen.add(songKey(song));
            s.ownedKeys.add(songKey(song));
        }

        s.phase = 'active';
        await persistSnapshot(s);
        const disposers = [
            folium.events.on('playback.songChanged', () => { void keepRunway(); }),
            folium.events.on('playback.queueChanged', (change) => {
                if (session !== s) return;
                if (change?.byThisMod) { void keepRunway(); return; }
                // 别人（用户、别的模组、宿主的撤销）动了队列：认同对方，退出但不还原。
                const queueNow = readQueue();
                const stillOurs = queueNow
                    && [...s.ownedKeys].some((key) => queueNow.items.some((item) => songKey(item.song) === key));
                if (!stillOurs) { endSession(s, false); return; }
                void keepRunway();
            }),
        ];
        s.unsubscribe = () => disposers.forEach((dispose) => { try { dispose(); } catch { /* 已经没了 */ } });
        paint();
        toast(say.ready, 'success');
        void keepRunway();
    };

    const startSession = () => {
        if (session) return;
        const state = playback.getState();
        if (!state.song) { toast(say.needSong, 'error'); return; }
        if (!source.available) { toast(say.unsupported, 'error'); return; }
        const s = {
            phase: 'preparing',
            cancelled: false,
            draft: emptyDraft(),
            likedIds: null,
            ownedKeys: new Set(),
            originalSongs: [],
            snapshotPairs: [],
            anchorSong: null,
            dryUntil: 0,
            unsubscribe: null,
        };
        session = s;
        paint();                                   // 先把按钮画成「准备中」：点击立刻有反应
        toast(say.preparing, 'info');
        void prepare(s).catch((error) => {
            folium.log?.warn?.('准备心动模式失败', error);
            if (session === s) {
                session = null;
                s.cancelled = true;
                paint();
                toast(explain(error), 'error');
            }
        });
    };

    const stopSession = () => {
        const s = session;
        if (!s) return;
        if (s.phase === 'preparing') { cancelPreparing(s); return; }
        s.unsubscribe?.();
        s.unsubscribe = null;
        endSession(s, true);
    };

    const toggle = () => {
        if (!session) startSession();
        else stopSession();
    };

    // ---------------------------------------------------------------- 开机还原

    /**
     * 上一次心动模式没正常退出（Folia 被关掉、崩溃）时，队列里留着模组放进去的歌。宿主会先把上次
     * 的队列恢复出来，这里等它准备好，然后再换回原来那份。
     */
    const recoverInterrupted = async () => {
        const record = await loadSnapshot();
        if (!record || !Array.isArray(record.songs)) return;
        const owned = new Set((Array.isArray(record.owned) ? record.owned : []).map(keyOfPair));
        if (owned.size === 0) { await clearSnapshot(); return; }
        const deadline = Date.now() + RESTORE_WAIT_MS;
        while (Date.now() < deadline) {
            if (disposed) return;                      // 模组被停用/重载：留下快照，下次启动再来
            if (session) return;                       // 用户已经自己开了
            const queue = (() => { try { return readQueue(); } catch { return null; } })();
            if (queue && queue.kind === 'queue' && queue.items.length > 0) {
                const hasOurs = queue.items.some((item) => owned.has(songKey(item.song)));
                if (!hasOurs) { await clearSnapshot(); return; }
                const songs = await resolvePairs(record.songs);
                if (songs.length > 0) {
                    const current = playback.getState().song;
                    const next = queueFromOriginal(songs, record.anchor ? { source: record.anchor[0], id: record.anchor[1] } : null, current);
                    const result = await replaceQueue(next, queue.version);
                    if (result?.status !== 'replaced') { await SLEEP(1500); continue; }
                }
                await clearSnapshot();
                toast(say.stopped, 'success');
                return;
            }
            await SLEEP(700);
        }
        await clearSnapshot();
    };

    // ---------------------------------------------------------------- 界面

    const mountButton = (container, ctx) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.style.cssText = [
            'all:unset',
            'cursor:pointer',
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'width:24px',
            'height:24px',
            'border-radius:7px',
            'opacity:0.72',
            'transition:opacity .15s ease,transform .15s ease,color .15s ease',
            'position:relative',
        ].join(';');
        container.appendChild(button);

        let icon = null;
        const painter = () => {
            const phase = session?.phase ?? null;
            const preparing = phase === 'preparing';
            const active = phase === 'active';
            const colors = ctx.getColors();
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
            button.setAttribute('aria-busy', preparing ? 'true' : 'false');
            button.title = preparing
                ? '正在准备心动模式（点击取消）'
                : active ? '退出心动模式（正在推荐）' : '开启心动模式（网易云推荐）';
            button.style.color = active ? (colors.fill || '#ec4899') : colors.text;
            button.style.opacity = preparing ? '0.45' : '0.72';
            button.style.cursor = preparing ? 'progress' : 'pointer';
            button.style.transform = preparing ? 'scale(0.9)' : 'scale(1)';
        };

        void folium.ui.icon('heart', { size: 15 }).then((element) => {
            if (!element) return;
            icon = element;
            button.replaceChildren(element);
            painter();
        }).catch(() => { /* 图标取不到也不影响按钮 */ });

        button.addEventListener('mouseenter', () => { if (!session) button.style.opacity = '1'; });
        button.addEventListener('mouseleave', () => { if (!session) button.style.opacity = '0.72'; });
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            toggle();
        });
        painters.add(painter);
        painter();
        ctx.onChange(painter);
        return () => {
            painters.delete(painter);
            button.remove();
        };
    };

    folium.registries.progressButtons.register({
        id: 'toggle',
        slot: 'progress.trailing',
        order: 400,
        mount: mountButton,
    });

    folium.registries.commands.register({
        id: 'start',
        label: { 'zh-CN': '开启心动模式', en: 'Start heart mode' },
        description: {
            'zh-CN': '随机一首「我喜欢的音乐」+ 两首网易云推荐，一组接一组无限循环',
            en: 'One random liked song and two recommendations, again and again',
        },
        keywords: ['heart', 'heartbeat', '心动', '推荐'],
        run: () => {
            startSession();
            return session ? '心动模式正在准备' : null;
        },
    });

    folium.registries.commands.register({
        id: 'stop',
        label: { 'zh-CN': '退出心动模式', en: 'Stop heart mode' },
        description: { 'zh-CN': '把播放队列放回开启前的样子', en: 'Put the queue back as it was' },
        keywords: ['heart', 'heartbeat', '心动'],
        run: () => {
            stopSession();
            return '心动模式已退出';
        },
    });

    void recoverInterrupted();

    return () => {
        disposed = true;
        const s = session;
        session = null;
        s?.unsubscribe?.();
        painters.clear();
        // 模组被停用或重载：别把用户的队列留在模组手里。
        if (s && s.phase === 'active') {
            void restoreOriginal(s).catch(() => { void clearSnapshot(); });
        } else {
            void clearSnapshot();
        }
    };
}