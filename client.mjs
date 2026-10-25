// client.mjs
// 心动模式（网易云）：随机从「我喜欢的音乐」抽一首歌，再向网易云心动接口要两首推荐，
// 之后一组一组无限接下去——1 首随机喜欢 + 2 首推荐，循环。
//
// 队列策略（v1.3.0 起）：开启后整条播放队列由模组接管，队首是正在放的那首，后面全是心动歌；
// 用户原来的队列只存快照，退出/停用时还原。之前是往原队列里插歌，但宿主的切歌逻辑用
// getPlaybackSongKey + findIndex 定位当前歌，抽到的喜欢歌在用户歌单里本来就有一份拷贝，
// 于是 findIndex 命中靠前那份、nextIndex 回到原歌单顺序——所以播完 1+2 就顺着喜欢列表走。
// 现在队列里没有重复 key，物理上不可能再落回原列表。
//
// 点击后立刻进入「准备中」并重画按钮，接口再慢也有反馈；再点一下取消。
// 播放链路完全交给宿主，模组只改队列：宿主自己的切歌会按正常流程加载音源、歌词与封面。
// 宿主给入口 URL 挂了 ?v=<内容摘要> 来让改过的模组重新加载，但**相对导入不会继承这个查询串**：
// 同一个 Folia 进程里改装后，浏览器模块表里的 './queue.mjs' 还是旧副本，会报
// “does not provide an export named ...”。所以依赖自己带版本号——每次改装把下面两个 ?v= 一起改掉。
import { readNeteaseCookie, requestHeartbeatSongIds } from './netease.mjs?v=1.3.1';
import {
    appendGroup,
    buildHeartbeatQueue,
    countOwnedAhead,
    hasOwned,
    playbackKey,
    restoreQueue,
} from './queue.mjs?v=1.3.1';

const LIKED_PAGE_SIZE = 50;      // 一次从「我喜欢的音乐」随机翻一页
const LIKED_POOL_TARGET = 8;     // 手头缓存几首候选，少打接口
const RECS_PER_GROUP = 2;        // 一组里两首推荐
const RUNWAY_TARGET = 9;         // 当前歌后面始终保持 9 首心动歌（3 组），够放十几分钟
const GROUPS_PER_REFILL = 3;     // 一次补跑最多补 3 组
const KEEP_HISTORY = 8;          // 队列里保留几首已播歌，让「上一首」还能回退
const MAX_REC_CALLS = 3;         // 一次补组最多打几次心动接口（防止上游重复）
const DETAIL_CONCURRENCY = 3;    // 推荐 id 换成宿主歌曲时的并发
const FM_FALLBACK_TRIES = 2;     // 心动接口给不出新歌时，私人 FM 兜底几次
const LIKED_PAGE_ATTEMPTS = 3;   // 随机翻页翻到空页/全听过的页时重试几次
const DRY_COOLDOWN_MS = 60_000;  // 一组都没拿到时歇一分钟
const SNAPSHOT_KEY = 'folia:heartbeat-mode:snapshot';
const SNAPSHOT_TRIES = 8;        // 宿主被关掉后，开机还原原队列的重试次数
const SNAPSHOT_INTERVAL = 700;

const readSnapshot = () => {
    try {
        const raw = globalThis.localStorage?.getItem?.(SNAPSHOT_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
    } catch { return null; }
};
const saveSnapshot = (queue) => {
    try { globalThis.localStorage?.setItem?.(SNAPSHOT_KEY, JSON.stringify(queue)); } catch { /* 没有存储 */ }
};
const clearSnapshot = () => {
    try { globalThis.localStorage?.removeItem?.(SNAPSHOT_KEY); } catch { /* 没有存储 */ }
};

export default function activate(folium) {
    const label = (zh, en) => ({ 'zh-CN': zh, en });
    // 导出窗口里没有播放队列，也没有 internals：那边直接不注册。
    if (folium.env.context !== 'main') return undefined;
    const internals = folium.internals;
    if (!internals) {
        folium.log.error('这个宿主没有提供 internals，心动模式无法访问播放队列');
        return undefined;
    }
    const store = internals.stores.playback;
    const omni = internals.omni;
    let session = null;
    let likedCache = null;
    let likedCacheOwner = null;
    // 进度条上每个按钮实例的「重画」函数；会话状态一变就把它们全刷一遍。
    const controlPainters = new Set();
    const refreshControlButtons = () => {
        for (const paint of [...controlPainters]) {
            try { paint(); } catch { /* 某个容器已经被宿主回收 */ }
        }
    };

    const toast = (message, type = 'info') => {
        try { folium.ui.toast(message, { type }); } catch { /* 导出窗口里没有界面 */ }
    };
    const providerOf = (song) => (song?.sourceRef?.kind === 'online' ? song.sourceRef.providerId : null);
    /** 网易云歌曲的数字 id：优先用 provider 的 mediaId（权威值），拿不到就退回 song.id。 */
    const neteaseId = (song) => {
        if (providerOf(song) !== 'netease') return null;
        const raw = song.sourceRef.mediaId ?? song.id;
        const numeric = Number(raw);
        return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
    };
    const isPlayable = (song) => {
        try { return omni.getSongAvailability(song)?.state !== 'unavailable'; } catch { return true; }
    };
    const randomInt = (max) => Math.floor(Math.random() * Math.max(1, max));
    const shuffled = (items) => {
        const copy = [...items];
        for (let index = copy.length - 1; index > 0; index -= 1) {
            const swap = randomInt(index + 1);
            const value = copy[index];
            copy[index] = copy[swap];
            copy[swap] = value;
        }
        return copy;
    };

    /** 找「我喜欢的音乐」：先用账号缓存里的，缓存没有就拉一次用户歌单。 */
    const findLikedPlaylist = async (summary) => {
        const owner = summary.user?.id ?? null;
        // 换了账号就不能复用上一个账号的「我喜欢的音乐」。
        if (likedCache && likedCacheOwner === owner) return likedCache;
        if (likedCache) likedCache = null;
        const cached = (summary.collections ?? []).find((collection) => collection.isLiked && collection.providerId === 'netease');
        if (cached) {
            likedCache = cached;
            likedCacheOwner = owner;
            return cached;
        }
        const userId = summary.user?.id;
        if (userId === undefined || userId === null) return null;
        const page = await omni.getProviderUserPlaylists('netease', userId, { limit: 50, offset: 0 });
        const found = (page?.items ?? []).find((collection) => collection.isLiked) ?? null;
        if (found) {
            likedCache = found;
            likedCacheOwner = owner;
        }
        return found;
    };

    /**
     * 随机翻一页「我喜欢的音乐」，把手头候选补到 LIKED_POOL_TARGET 首。
     * 歌单很大时用随机 offset 从整张歌单抽，而不是永远从第一首开始。
     */
    const fillLikedPool = async (draft, liked) => {
        const total = Number(liked?.trackCount) || 0;
        for (let attempt = 0; attempt < LIKED_PAGE_ATTEMPTS; attempt += 1) {
            let offset;
            if (total > LIKED_PAGE_SIZE) offset = randomInt(total - LIKED_PAGE_SIZE + 1);
            else if (total > 0) offset = 0;
            else offset = attempt === 0 ? 0 : randomInt(LIKED_PAGE_SIZE * 20);

            try {
                const page = await omni.getCollectionTracks(liked, { limit: LIKED_PAGE_SIZE, offset });
                const items = page?.items ?? [];
                const candidates = shuffled(items).filter((song) => (
                    song
                    && providerOf(song) === 'netease'
                    && isPlayable(song)
                    && !draft.seen.has(playbackKey(song))
                    && !draft.reserved.has(playbackKey(song))
                    && !draft.poolKeys.has(playbackKey(song))
                ));
                for (const song of candidates) {
                    if (draft.pool.length >= LIKED_POOL_TARGET) break;
                    draft.pool.push(song);
                    draft.poolKeys.add(playbackKey(song));
                }
                if (draft.pool.length > 0) return true;
            } catch (error) {
                folium.log.warn('心动模式：随机读「我喜欢的音乐」失败', { message: String(error?.message || error) });
            }
        }
        return false;
    };

    /** 从候选池里挑一首还没在本会话出现过的喜欢，挑完就从池里拿掉。 */
    const nextLikedSong = async (draft, liked) => {
        if (!liked) return null;
        for (let guard = 0; guard < 3; guard += 1) {
            while (draft.pool.length > 0) {
                const song = draft.pool.shift();
                const key = playbackKey(song);
                if (draft.seen.has(key) || draft.reserved.has(key)) continue;
                const current = store.getState().currentSong;
                if (current && playbackKey(current) === key) continue;
                return song;
            }
            if (!(await fillLikedPool(draft, liked))) return null;
        }
        return null;
    };

    /** 推荐 id → 宿主歌曲对象：走 omni 的网易云 provider，拿到的对象带 privilege、时长和封面。 */
    const resolveSongs = async (ids) => {
        const byId = new Map();
        let cursor = 0;
        const worker = async () => {
            while (cursor < ids.length) {
                const id = ids[cursor];
                cursor += 1;
                try {
                    const song = await omni.getSongDetail('netease', id);
                    if (song) byId.set(id, song);
                } catch (error) {
                    folium.log.warn('心动模式：取推荐歌曲详情失败', { id, message: String(error?.message || error) });
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, ids.length) }, worker));
        return ids.map((id) => byId.get(id)).filter(Boolean);
    };

    /**
     * 一组推荐：先向心动接口要，接口一次给不够就再要（老后端会忽略 count，一次只回一首），
     * 上游开始重复或给不出新歌时，用私人 FM 补足。
     */
    const fetchGroupRecs = async (draft, seedSong, want) => {
        const seedSongId = neteaseId(seedSong);
        if (seedSongId === null) return [];

        const exclude = new Set(draft.seen);
        exclude.add(playbackKey(seedSong));
        for (const key of draft.reserved) exclude.add(key);
        const current = store.getState().currentSong;
        if (current) exclude.add(playbackKey(current));

        const collected = [];
        const take = (songs) => {
            let added = 0;
            for (const song of songs ?? []) {
                if (collected.length >= want) break;
                if (!song || providerOf(song) !== 'netease' || !isPlayable(song)) continue;
                const key = playbackKey(song);
                if (exclude.has(key)) continue;
                exclude.add(key);
                collected.push(song);
                added += 1;
            }
            return added;
        };

        for (let attempt = 0; attempt < MAX_REC_CALLS && collected.length < want; attempt += 1) {
            let ids;
            try {
                ids = await requestHeartbeatSongIds(folium, {
                    seedSongId,
                    playlistId: draft.playlistId,
                    cookie: readNeteaseCookie(),
                    count: want - collected.length,
                });
            } catch (error) {
                folium.log.warn('心动模式：推荐接口不可用', { message: String(error?.message || error) });
                break;
            }

            const freshIds = ids.filter((id) => {
                const key = `online:netease:${id}`;
                return !exclude.has(key) && !draft.requested.has(key);
            });
            if (freshIds.length === 0) break;   // 上游只回已经拿过的歌：别再打
            freshIds.forEach((id) => draft.requested.add(`online:netease:${id}`));

            const songs = await resolveSongs(freshIds);
            take(songs);
        }

        for (let attempt = 0; attempt < FM_FALLBACK_TRIES && collected.length < want; attempt += 1) {
            try {
                const songs = await omni.getPersonalFm();
                if (take(songs ?? []) === 0) break;
            } catch (error) {
                folium.log.warn('心动模式：私人 FM 兜底失败', { message: String(error?.message || error) });
                break;
            }
        }
        return collected;
    };

    /** 把「当前队列里已经有的歌」记下来，选新歌时避开：队列里出现重复 key 会让宿主切错位置。 */
    const refreshReserved = (draft) => {
        draft.reserved = new Set((store.getState().playQueue ?? []).map((song) => playbackKey(song)));
    };

    const adoptLiked = (active, song) => {
        const key = playbackKey(song);
        active.draft.seen.add(key);
        active.draft.likedKeys.add(key);
        active.ownedKeys.add(key);
    };
    const adoptRecs = (active, songs) => {
        for (const song of songs) {
            const key = playbackKey(song);
            active.draft.seen.add(key);
            active.draft.recKeys.add(key);
            active.ownedKeys.add(key);
        }
    };

    /**
     * 喜欢的歌放完之后允许重新来过：把喜欢的 key 从 seen 里摘掉，让下一轮还能抽到，
     * 这样小歌单也能无限循环（而不是一轮之后就没歌可选）。推荐同理。
     */
    const recycleLiked = (draft) => {
        for (const key of draft.likedKeys) draft.seen.delete(key);
        draft.likedKeys.clear();
        draft.pool = [];
        draft.poolKeys.clear();
    };
    const recycleRecs = (draft) => {
        for (const key of draft.recKeys) draft.seen.delete(key);
        draft.recKeys.clear();
        draft.requested.clear();
    };

    /** 队列只留当前歌和后面几首历史：播过的老歌退场，key 才能安全复用。 */
    const trimQueue = (queue, currentSong) => {
        const currentKey = currentSong ? playbackKey(currentSong) : null;
        const index = currentKey ? queue.findIndex((song) => playbackKey(song) === currentKey) : -1;
        if (index <= KEEP_HISTORY) return queue;
        return queue.slice(index - KEEP_HISTORY);
    };

    /** 造一组：1 首随机喜欢 + 2 首推荐；喜欢或推荐都凑不出来时返回 null。 */
    const nextGroup = async (active) => {
        const draft = active.draft;

        let likedSong = await nextLikedSong(draft, active.liked);
        if (session !== active) return null;
        if (!likedSong) {
            recycleLiked(draft);
            refreshReserved(draft);
            likedSong = await nextLikedSong(draft, active.liked);
        }
        if (!likedSong) return null;

        let recommendations = await fetchGroupRecs(draft, likedSong, RECS_PER_GROUP);
        if (session !== active) return null;
        if (recommendations.length === 0) {
            recycleRecs(draft);
            refreshReserved(draft);
            recommendations = await fetchGroupRecs(draft, likedSong, RECS_PER_GROUP);
        }
        if (recommendations.length === 0) return null;

        adoptLiked(active, likedSong);
        adoptRecs(active, recommendations);
        return { songs: [likedSong, ...recommendations] };
    };

    /** 会话结束：撤订阅、放掉会话，把按钮重画回空闲。 */
    const clearSession = (active) => {
        if (session !== active) return;
        session = null;
        active.cancelled = true;
        try { active.unsubscribe?.(); } catch { /* 已经撤下 */ }
        active.unsubscribe = null;
        refreshControlButtons();
    };

    const endSession = (active, restore) => {
        if (session !== active) return;
        clearSession(active);
        if (!restore) {
            // 用户自己把队列换了：尊重现在这条队列，快照也一并丢掉，别再改第二次。
            clearSnapshot();
            toast('心动模式已退出（播放队列被你换掉了）', 'info');
            return;
        }
        const state = store.getState();
        const removed = state.playQueue.filter((song) => active.ownedKeys.has(playbackKey(song))).length;
        const queue = restoreQueue(state.currentSong, active.originalQueue, active.anchorSong);
        clearSnapshot();
        store.getState().setPlayQueue(queue);
        toast(`已退出心动模式，恢复开启前的队列（移除 ${removed} 首心动歌曲）`, 'success');
    };

    /** 准备中再点一下：只收掉会话，队列一点不动。 */
    const cancelSession = () => {
        const active = session;
        if (!active || active.phase !== 'preparing') return;
        clearSession(active);
        clearSnapshot();
        toast('已取消心动模式', 'info');
    };

    /** 开启的第一组：随机喜欢 + 两首推荐，然后把整条队列换成心动队列。 */
    const prepare = async (active, summary, currentSong) => {
        const isCancelled = () => active.cancelled || session !== active;
        const fail = (message) => {
            clearSession(active);
            clearSnapshot();
            toast(message, 'error');
            return message;
        };

        const draft = {
            playlistId: null,
            seen: new Set(),
            likedKeys: new Set(),
            recKeys: new Set(),
            requested: new Set(),
            reserved: new Set(),
            pool: [],
            poolKeys: new Set(),
        };
        if (currentSong) draft.seen.add(playbackKey(currentSong));
        // 这时队列还是用户原来的歌单（马上整条换掉），所以只把正在放的这首当保留。
        if (currentSong) draft.reserved.add(playbackKey(currentSong));
        active.draft = draft;

        const liked = await findLikedPlaylist(summary);
        if (isCancelled()) return '已取消';
        active.liked = liked;
        draft.playlistId = liked?.id ?? null;

        let likedSong = await nextLikedSong(draft, liked);
        if (isCancelled()) return '已取消';
        if (!likedSong) {
            recycleLiked(draft);
            likedSong = await nextLikedSong(draft, liked);
        }
        if (isCancelled()) return '已取消';

        let recommendations = [];
        if (likedSong) {
            recommendations = await fetchGroupRecs(draft, likedSong, RECS_PER_GROUP);
        } else if (neteaseId(currentSong) !== null) {
            // 「我喜欢的音乐」里没有能播的歌（空歌单/全下架）：把正在播的这首当推荐种子。
            recommendations = await fetchGroupRecs(draft, currentSong, RECS_PER_GROUP);
        } else {
            return fail('「我喜欢的音乐」里没有可以播放的歌');
        }
        if (isCancelled()) return '已取消';
        if (recommendations.length === 0) {
            recycleRecs(draft);
            recommendations = await fetchGroupRecs(draft, likedSong ?? currentSong, RECS_PER_GROUP);
        }
        if (recommendations.length === 0) return fail('网易云这次没有给出推荐，稍后再试');

        if (likedSong) adoptLiked(active, likedSong);
        adoptRecs(active, recommendations);
        const group = likedSong ? [likedSong, ...recommendations] : recommendations;

        const state = store.getState();
        // 私人 FM 模式下队列推进走 FM 分支，会绕开被接管的队列；先落回普通队列。
        if (state.isFmMode && typeof state.setIsFmMode === 'function') state.setIsFmMode(false);
        active.originalQueue = [...(state.playQueue ?? [])];
        active.anchorSong = state.currentSong;
        saveSnapshot(active.originalQueue);
        store.getState().setPlayQueue(buildHeartbeatQueue(state.currentSong, group));
        active.phase = 'active';
        active.unsubscribe = store.subscribe(onStoreChange);
        refreshControlButtons();
        toast('心动模式已开启：1 首喜欢的歌 + 2 首推荐，之后一直循环下去', 'success');
        void ensureRunway(active);
        return null;
    };

    /**
     * 维持跑道：当前歌后面始终留着 RUNWAY_TARGET 首心动歌，网络慢也够放完一组再补上，
     * 永远不会出现「后面没歌了 → 掉回用户原列表」的空档。
     */
    const ensureRunway = async (active) => {
        if (session !== active || active.phase !== 'active' || active.fetching) return;
        // 一次没拉到新歌就歇一分钟：store 订阅会被播放/暂停等状态频繁唤醒，
        // 不设冷却会在后端没推荐时反复打同一个接口。
        if (Date.now() < active.dryUntil) return;
        active.fetching = true;
        try {
            for (let round = 0; round < GROUPS_PER_REFILL; round += 1) {
                if (session !== active) return;
                const before = store.getState();
                const ahead = countOwnedAhead(before.playQueue, before.currentSong);
                if (ahead >= RUNWAY_TARGET) return;
                // 先把播过的老歌从队列里裁掉（留 KEEP_HISTORY 首），这样歌单很小时
                // 「喜欢的歌放完重来」也不会撞上队列里还在的同一首 key。
                if (ahead > 0) {
                    const trimmed = trimQueue(before.playQueue, before.currentSong);
                    if (trimmed !== before.playQueue) store.getState().setPlayQueue(trimmed);
                }
                refreshReserved(active.draft);
                const group = await nextGroup(active);
                if (session !== active) return;
                if (!group) {
                    active.dryUntil = Date.now() + DRY_COOLDOWN_MS;
                    return;
                }
                const state = store.getState();
                const present = new Set(state.playQueue.map((song) => playbackKey(song)));
                const fresh = group.songs.filter((song) => !present.has(playbackKey(song)));
                if (fresh.length === 0) continue;
                store.getState().setPlayQueue(appendGroup(state.playQueue, fresh));
            }
        } finally {
            if (session === active) active.fetching = false;
        }
    };

    /** 队列一变就看一眼：跑量不够就补组，队列被整个换掉就自己收摊。 */
    const onStoreChange = () => {
        const active = session;
        if (!active || active.phase !== 'active') return;
        const state = store.getState();
        if (!hasOwned(state.playQueue, active.ownedKeys)) {
            endSession(active, false);
            return;
        }
        if (countOwnedAhead(state.playQueue, state.currentSong) < RUNWAY_TARGET) {
            void ensureRunway(active);
        }
    };

    /** 命令面板与进度条按钮都从这里进；意外错误只记日志 + 提示，不让命令抛出去。 */
    const start = async () => {
        if (session) {
            const message = session.phase === 'preparing' ? '心动模式正在准备中' : '心动模式已经在运行';
            toast(message);
            return message;
        }
        if (folium.env.context !== 'main') return '心动模式只在主窗口可用';

        const summary = (omni.getProviderSummaries() ?? []).find((entry) => entry.providerId === 'netease');
        if (!summary || summary.status !== 'authenticated' || !summary.user) {
            toast('心动模式需要先登录网易云', 'error');
            return '请先登录网易云';
        }

        const state = store.getState();
        const currentSong = state.currentSong;
        if (!currentSong) {
            toast('先播放任意一首歌，再开启心动模式', 'error');
            return '当前没有在播的歌';
        }

        const active = {
            phase: 'preparing',
            cancelled: false,
            draft: null,
            liked: null,
            ownedKeys: new Set(),
            originalQueue: [],
            anchorSong: null,
            unsubscribe: null,
            fetching: false,
            dryUntil: 0,
        };
        // 先落会话、先重画、先提示：接口再慢，点击也立刻有反馈。
        session = active;
        refreshControlButtons();
        toast('心动模式：正在挑选喜欢的歌和推荐…');
        try {
            const problem = await prepare(active, summary, currentSong);
            return problem ?? '心动模式已开启';
        } catch (error) {
            clearSession(active);
            folium.log.error('心动模式：开启失败', { message: String(error?.message || error) });
            toast('心动模式开启失败，详情见模组面板', 'error');
            return '开启失败';
        }
    };

    const stop = () => {
        const active = session;
        if (!active) {
            toast('心动模式没有在运行');
            return '心动模式没有在运行';
        }
        if (active.phase === 'preparing') {
            cancelSession();
            return '已取消';
        }
        endSession(active, true);
        return '已退出心动模式';
    };

    /** 心跳动画只注入一次，多个按钮实例共用。 */
    const ensurePulseStyle = (doc) => {
        try {
            if (!doc || typeof doc.getElementById !== 'function' || doc.getElementById('folium-heartbeat-style')) return;
            const style = doc.createElement('style');
            style.id = 'folium-heartbeat-style';
            style.textContent = '@keyframes folium-heartbeat-pulse{0%,100%{opacity:.4}50%{opacity:.95}}';
            const head = doc.head ?? doc.documentElement;
            head?.appendChild?.(style);
        } catch { /* 没有 DOM 的环境（测试/导出）跳过 */ }
    };

    /**
     * 进度条上的心动按钮：三处进度条（悬浮控件两处、Lattice）各挂一份。
     * 每份只画自己的 DOM；状态变化由 refreshControlButtons 统一重画。
     */
    const mountControlButton = (container) => {
        const doc = container.ownerDocument ?? globalThis.document;
        ensurePulseStyle(doc);
        const button = doc.createElement('button');
        button.type = 'button';
        button.style.cssText = [
            'display:inline-flex', 'align-items:center', 'justify-content:center',
            'width:26px', 'height:26px', 'padding:0', 'border:0', 'border-radius:8px',
            'background:transparent', 'color:inherit', 'cursor:pointer', 'pointer-events:auto',
            'opacity:.72', 'transition:opacity .15s ease, color .15s ease, background-color .15s ease',
        ].join(';');

        const iconBox = doc.createElement('span');
        iconBox.style.cssText = 'display:inline-flex;line-height:0;pointer-events:none';
        iconBox.textContent = '♡';   // 图标还没到位（或这个名字不存在）时的兜底
        button.appendChild(iconBox);
        container.appendChild(button);

        let disposed = false;
        // 图标是宿主的 lucide 元素，每个容器各取一份（元素归模组，appendChild 会把它移过来）。
        try {
            void Promise.resolve(folium.ui.icon('heart-pulse', { size: 15 }))
                .then((icon) => { if (icon && !disposed) iconBox.replaceChildren(icon); })
                .catch(() => undefined);
        } catch { /* 老宿主没有 ui.icon：留着兜底字符 */ }

        const paint = () => {
            const phase = session?.phase ?? 'idle';
            const preparing = phase === 'preparing';
            const active = phase === 'active';
            const title = preparing
                ? '正在准备心动模式（点击取消）'
                : active
                    ? '退出心动模式（正在推荐）'
                    : '开启心动模式（网易云推荐）';
            button.title = title;
            button.setAttribute('aria-label', title);
            button.setAttribute('aria-busy', String(preparing));
            button.setAttribute('aria-pressed', String(active));
            button.style.color = preparing || active
                ? 'var(--folium-accent, currentColor)'
                : 'var(--folium-primary, currentColor)';
            button.style.opacity = preparing ? '0.5' : active ? '1' : '0.72';
            button.style.background = preparing
                ? 'color-mix(in srgb, currentColor 10%, transparent)'
                : active
                    ? 'color-mix(in srgb, currentColor 16%, transparent)'
                    : 'transparent';
            button.style.cursor = preparing ? 'progress' : 'pointer';
            button.style.animation = preparing ? 'folium-heartbeat-pulse 1.2s ease-in-out infinite' : '';
        };

        const onClick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            const phase = session?.phase ?? 'idle';
            if (phase === 'preparing') {
                cancelSession();
                return;
            }
            if (phase === 'active') {
                stop();
                return;
            }
            void Promise.resolve(start()).catch((error) => {
                folium.log.error('心动模式：开启失败', { message: String(error?.message || error) });
                toast('心动模式开启失败，详情见模组面板', 'error');
            });
        };

        button.addEventListener('click', onClick);
        controlPainters.add(paint);
        paint();

        return () => {
            disposed = true;
            controlPainters.delete(paint);
            button.removeEventListener('click', onClick);
            button.remove();
        };
    };

    /**
     * 上次开着心动模式时宿主被关掉的话，播放队列里留下的还是心动歌；这里把原队列换回去，
     * 免得用户下次打开发现「我喜欢的音乐」整条队列都不见了。
     */
    const restoreInterruptedSession = () => {
        const pending = readSnapshot();
        if (!pending) return;
        const pendingKeys = pending.map((song) => playbackKey(song)).join('|');
        let tries = 0;
        const timer = setInterval(() => {
            tries += 1;
            if (session) {
                // 用户已经重新开了心动模式，新会话自己管快照。
                clearInterval(timer);
                return;
            }
            if (tries > SNAPSHOT_TRIES) {
                clearInterval(timer);
                clearSnapshot();
                return;
            }
            const state = store.getState();
            if (!state.currentSong) return;
            const nowKeys = (state.playQueue ?? []).map((song) => playbackKey(song)).join('|');
            if (nowKeys === pendingKeys) {
                // 队列已经是原队列（是宿主自己恢复的，或者上次已经换回去）：收工。
                clearInterval(timer);
                clearSnapshot();
                return;
            }
            store.getState().setPlayQueue(pending);
        }, SNAPSHOT_INTERVAL);
    };

    restoreInterruptedSession();

    folium.registries.commands.register({
        id: 'start',
        label: label('开启心动模式', 'Start Heartbeat'),
        description: label(
            '接管播放队列：随机一首「我喜欢的音乐」+ 两首网易云推荐，一组接一组无限循环',
            'Take over the queue: one random liked song plus two NetEase recommendations, looping forever',
        ),
        keywords: ['heartbeat', 'intelligence', 'netease', '心动', '心动模式', 'xindong', 'xdmoshi', '网易云推荐'],
        run: () => start(),
    });
    folium.registries.controlButtons.register({
        id: 'toggle',
        slot: 'progress.trailing',
        order: 400,
        mount: mountControlButton,
    });
    folium.registries.commands.register({
        id: 'stop',
        label: label('退出心动模式', 'Stop Heartbeat'),
        description: label('恢复开启心动模式前的队列', 'Restore the queue you had before Heartbeat started'),
        keywords: ['heartbeat', 'stop', '心动', '退出心动模式', 'tuichu'],
        run: () => stop(),
    });

    // 模组被停用/卸载时把队列还原，别让用户下次打开时队列里多一堆没头没尾的歌。
    return () => {
        const active = session;
        if (!active) return;
        if (active.phase === 'preparing') clearSession(active);
        else endSession(active, true);
        clearSnapshot();
    };
}