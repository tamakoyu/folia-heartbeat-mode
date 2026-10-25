// test/harness.mjs
// 心动模式模组的本地回路：用假的 folium / internals / 网易后端驱动真实代码，检查队列行为。
//
// v1.3.0 的模型是「整个队列由模组接管」：开启后队列只有 [当前歌, 喜欢, 推荐, 推荐, 喜欢, …]，
// 用户原来的队列只留一份快照。所以这一版断言的铁律是：
//   1) 队列里永远不出现重复 key（宿主切歌靠 findIndex，重复 key 就是掉回原列表的根因）；
//   2) 队首之外永远只有本会话的喜欢歌和推荐歌，原队列的其它歌一首都不许冒出来；
//   3) 播放顺序永远是 1 喜欢 + 2 推荐，一组接一组，放多久都不会断。
// 跑法：node test/harness.mjs
import assert from 'node:assert/strict';
import activate from '../client.mjs';
import {
    appendGroup,
    buildHeartbeatQueue,
    countOwnedAhead,
    hasOwned,
    playbackKey,
    restoreQueue,
} from '../queue.mjs';

const song = (id, providerId = 'netease') => ({
    id,
    name: `Song ${id}`,
    artists: [{ id: 1, name: 'Artist' }],
    album: { id: 2, name: 'Album' },
    durationMs: 180000,
    sourceRef: { kind: 'online', providerId, mediaId: String(id) },
});

const idsOf = (queue) => queue.map((entry) => entry?.id);
const keysOf = (queue) => queue.map((entry) => playbackKey(entry));

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const heartbeatPayload = (...ids) => ({ code: 200, data: ids.map((id) => ({ songInfo: { id } })) });

/** 按顺序一次回 N 首，给完就空（模拟 count 被忽略、上游每次只给一首）。 */
const sequenceEndpoint = (...ids) => {
    let index = 0;
    return () => (index < ids.length ? heartbeatPayload(ids[index++]) : heartbeatPayload());
};

/** 每次回两首（模拟 count 生效）：101/102、103/104…… */
const pairEndpoint = (startId = 101) => {
    let next = startId;
    return () => {
        const payload = heartbeatPayload(next, next + 1);
        next += 2;
        return payload;
    };
};

/** 每次只回一首、编号递增（模拟 count 被忽略但上游愿意一首一首给）。 */
const onePerCallEndpoint = (startId = 101) => {
    let next = startId;
    return () => heartbeatPayload(next++);
};

/** 每次都回同一首（模拟上游去重后原地打转）。 */
const stuckEndpoint = (id = 101) => () => heartbeatPayload(id);

/** 最小 DOM：模组的进度条按钮只会用到这几个方法。 */
const createElement = (tagName) => {
    const element = {
        tagName,
        children: [],
        attributes: {},
        listeners: {},
        style: { cssText: '' },
        textContent: '',
        ownerDocument: null,
        appendChild(child) { child.parent = element; element.children.push(child); return child; },
        replaceChildren(...nodes) { element.children.forEach((child) => { child.parent = null; }); element.children = nodes; nodes.forEach((node) => { node.parent = element; }); },
        setAttribute(name, value) { element.attributes[name] = String(value); },
        addEventListener(type, handler) { element.listeners[type] = handler; },
        removeEventListener(type) { delete element.listeners[type]; },
        remove() {
            if (element.parent) {
                element.parent.children = element.parent.children.filter((child) => child !== element);
                element.parent = null;
            }
            element.removed = true;
        },
        click() { element.listeners.click?.({ preventDefault() {}, stopPropagation() {} }); },
    };
    element.ownerDocument = { createElement };
    return element;
};

const stubProgressContext = {
    getColors: () => ({ fill: '#ffffff', track: '#000000', text: '#ffffff' }),
    subscribe: () => () => {},
};

/** 最小 zustand 形状的 store：getState / setState / subscribe，够模组用。 */
const createStore = (initial) => {
    let state = initial;
    const listeners = new Set();
    const setState = (patch) => {
        state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
        for (const listener of [...listeners]) listener(state);
    };
    return {
        getState: () => state,
        setState,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
};

const LIKED_BASE = { providerId: 'netease', id: 'liked-1', name: '我喜欢的音乐', type: 'playlist', isLiked: true };
const SNAPSHOT_KEY = 'folia:heartbeat-mode:snapshot';

const createEnv = (options = {}) => {
    const {
        port = 3000,
        cookie = 'session-cookie',
        loggedIn = true,
        currentSong = song(12),
        queue = [song(11), song(12), song(13)],
        fmMode = false,
        likedSongs = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30].map((id) => song(id)),
        likedTotal = likedSongs.length,
        endpoint = () => heartbeatPayload(),
        details = {},
        offShelf = [],
        fm = [],
        hasBridge = true,
        snapshot = null,
    } = options;

    globalThis.window = hasBridge ? { electron: { getNeteasePort: async () => port } } : {};

    // 模组只用 getItem/setItem/removeItem，用 Map 撑起来就好。
    const storage = new Map();
    if (cookie) storage.set('online_provider:netease:cookie', cookie);
    if (snapshot) storage.set(SNAPSHOT_KEY, JSON.stringify(snapshot));
    globalThis.localStorage = {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => { storage.set(key, String(value)); },
        removeItem: (key) => { storage.delete(key); },
    };

    const toasts = [];
    const logs = [];
    const fetchCalls = [];
    const pageCalls = [];
    const commands = new Map();
    const controlButtons = new Map();

    const store = createStore({
        currentSong,
        playQueue: [...queue],
        isFmMode: fmMode,
        setPlayQueue(next) {
            store.setState((state) => ({ playQueue: typeof next === 'function' ? next(state.playQueue) : next }));
        },
        setIsFmMode(next) {
            store.setState({ isFmMode: Boolean(next) });
        },
    });

    let fmIndex = 0;
    const liked = { ...LIKED_BASE, trackCount: likedTotal };

    const omni = {
        getProviderSummaries: () => [{
            providerId: 'netease',
            status: loggedIn ? 'authenticated' : 'anonymous',
            user: loggedIn ? { id: 7, nickname: 'Listener' } : null,
            collections: loggedIn ? [liked] : [],
        }],
        getProviderUserPlaylists: async () => ({ items: [liked], hasMore: false, nextOffset: 1 }),
        getCollectionTracks: async (_collection, page = {}) => {
            const limit = Number(page.limit) || 50;
            const offset = Number(page.offset) || 0;
            pageCalls.push({ limit, offset });
            const items = likedSongs.slice(offset, offset + limit);
            return { items, hasMore: offset + items.length < likedSongs.length, nextOffset: offset + items.length };
        },
        getSongDetail: async (_providerId, id) => details[id] ?? song(id),
        getSongAvailability: (entry) => (offShelf.includes(Number(entry.id)) ? { state: 'unavailable', reason: 'taken-down' } : { state: 'playable' }),
        getPersonalFm: async () => {
            if (fmIndex >= fm.length) return [];
            const entry = fm[fmIndex];
            fmIndex += 1;
            return Array.isArray(entry) ? entry : [entry];
        },
    };

    const folium = {
        modId: 'heartbeat-mode',
        host: { folium: { major: 1, minor: 4 }, folia: '0.7.18' },
        env: { context: 'main' },
        log: {
            info: (message, meta) => logs.push({ level: 'info', message, meta }),
            warn: (message, meta) => logs.push({ level: 'warn', message, meta }),
            error: (message, meta) => logs.push({ level: 'error', message, meta }),
        },
        registries: {
            commands: {
                register: (def) => {
                    commands.set(def.id, def);
                    return { id: def.id, unregister: () => commands.delete(def.id) };
                },
            },
            controlButtons: {
                register: (def) => {
                    controlButtons.set(def.id, def);
                    return { id: def.id, unregister: () => controlButtons.delete(def.id) };
                },
            },
        },
        ui: {
            toast: (message, config) => toasts.push({ message, ...(config ?? {}) }),
            icon: async (name) => (name === 'heart-pulse' ? createElement('svg') : null),
        },
        net: {
            fetch: async (url) => {
                fetchCalls.push(String(url));
                const payload = await endpoint(String(url), fetchCalls.length);
                if (typeof payload === 'string') return { status: 404, ok: false, text: () => payload };
                return { status: 200, ok: true, text: () => JSON.stringify(payload) };
            },
        },
        internals: { stores: { playback: store }, omni },
    };

    return {
        folium, store, omni, liked, likedSongs,
        toasts, logs, fetchCalls, pageCalls, commands, controlButtons,
        storage,
        snapshotValue: () => {
            const raw = storage.get(SNAPSHOT_KEY);
            return raw ? JSON.parse(raw) : null;
        },
    };
};

const runStart = (env) => env.commands.get('start').run({ values: {} });
const runStop = (env) => env.commands.get('stop').run({ values: {} });

const mountButton = (env) => {
    const container = createElement('div');
    env.controlButtons.get('toggle').mount(container, stubProgressContext);
    return { container, button: container.children[0] };
};

/** 队列不变量：key 唯一、非队首的歌全是本会话的喜欢（21-30）或推荐（>=101）。 */
const assertHeartbeatQueue = (queue, likedIds = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30]) => {
    const keys = keysOf(queue);
    assert.equal(new Set(keys).size, keys.length, `队列里出现重复 key：${keys.join(' , ')}`);
    for (const entry of queue.slice(1)) {
        const id = Number(entry.id);
        const ok = likedIds.includes(id) || id >= 101;
        assert.ok(ok, `队首之外混进了非心动歌曲：${entry.id}`);
    }
};

/** 模拟宿主往下播一首：把 currentSong 设成队列里当前歌的下一首，并返回它。 */
const playNext = (env) => {
    const state = env.store.getState();
    const index = state.playQueue.findIndex((entry) => playbackKey(entry) === playbackKey(state.currentSong));
    assert.ok(index >= 0, '当前歌应该还在队列里');
    const next = state.playQueue[index + 1];
    assert.ok(next, '当前歌后面应该还有歌（跑道不能断）');
    env.store.setState({ currentSong: next });
    return next;
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------- queue.mjs 单元

test('queue.playbackKey：在线/本地/舞台/Navidrome 与宿主的 key 规则一致', () => {
    assert.equal(playbackKey(song(42)), 'online:netease:42');
    assert.equal(playbackKey({ id: 42, sourceRef: { kind: 'online', providerId: 'qobuz', mediaId: 'abc' } }), 'online:qobuz:abc');
    assert.equal(playbackKey({ id: 9, sourceRef: { kind: 'local', mediaId: 'L9' } }), 'local:L9');
    assert.equal(playbackKey({ id: 9, isStage: true }), 'stage:9');
    assert.equal(playbackKey({ id: 9, isLocal: true, localRef: { songId: 'L9' } }), 'local:L9');
    assert.equal(playbackKey({ id: 9, isNavidrome: true, navidromeData: { id: 'N9' } }), 'navidrome:N9');
    // 没有 isNavidrome 标记的 navidromeData 宿主不会当 Navidrome 认，这里跟宿主保持一致。
    assert.equal(playbackKey({ id: 9, navidromeData: { id: 'N9' } }), 'online:netease:9');
    assert.equal(playbackKey({ id: 42 }), 'online:netease:42', '老数据没有 sourceRef 也按网易云算');
    assert.equal(playbackKey(null), '');
});

test('queue：队列拼装、补组、跑道计数、还原', () => {
    const a = song(1);
    const b = song(2);
    assert.deepEqual(idsOf(buildHeartbeatQueue(a, [b])), [1, 2]);
    assert.deepEqual(idsOf(buildHeartbeatQueue(null, [b])), [2], '没有在播的歌时不硬塞队首');
    assert.deepEqual(idsOf(appendGroup([a], [b])), [1, 2]);
    const queue = [a, b];
    assert.equal(countOwnedAhead(queue, a), 1);
    assert.equal(countOwnedAhead(queue, b), 0);
    assert.equal(countOwnedAhead(queue, song(99)), 2, '当前歌不在队列里时整条都算「后面」');
    assert.equal(countOwnedAhead([], a), 0);
    assert.equal(hasOwned(queue, new Set(['online:netease:2'])), true);
    assert.equal(hasOwned(queue, new Set(['online:netease:3'])), false);

    // 还原：从开启时正在放的那首之后接起。
    const snapshot = [song(11), song(12), song(13)];
    assert.deepEqual(idsOf(restoreQueue(song(12), snapshot, song(12))), [13, 11, 12]);
    // 当前歌（心动歌）不在快照里：前置，后面接锚点之后的歌。
    assert.deepEqual(idsOf(restoreQueue(song(101), snapshot, song(12))), [101, 13, 11, 12]);
    // 锚点也找不到：原样还回去。
    assert.deepEqual(idsOf(restoreQueue(song(101), snapshot, song(77))), [101, 11, 12, 13]);
    assert.deepEqual(idsOf(restoreQueue(song(101), [], null)), [101]);
});

// ---------------------------------------------------------------- 开启

test('开启：点击立刻进入准备中，成功后整条队列被接管（当前歌 + 1 喜欢 + 2 推荐…）', async () => {
    const env = createEnv({ endpoint: pairEndpoint(101) });
    activate(env.folium);
    const { button } = mountButton(env);

    button.click();
    // 还没等任何接口返回，按钮就应该已经变了：这是「点了没反应」的正面用例。
    assert.equal(button.attributes['aria-busy'], 'true', '点击后同步进入 busy');
    assert.match(button.title, /正在准备/);
    assert.match(env.toasts.at(-1).message, /正在挑选/);

    await tick(120);

    const ids = idsOf(env.store.getState().playQueue);
    assert.equal(ids[0], 12, '队首还是正在放的那首');
    assert.ok(env.likedSongs.some((entry) => entry.id === ids[1]), '第一首是随机的喜欢');
    assert.deepEqual(ids.slice(2, 4), [101, 102], '后两首是推荐');
    assert.equal(ids.length, 10, '跑道补满 3 组（1 + 9）');
    assert.ok(!ids.includes(11) && !ids.includes(13), '用户原队列的歌被整体换出去了');
    assertHeartbeatQueue(env.store.getState().playQueue);
    assert.equal(button.attributes['aria-busy'], 'false');
    assert.equal(button.attributes['aria-pressed'], 'true');
    assert.match(button.title, /退出心动模式/);
    assert.match(env.toasts.at(-1).message, /1 首喜欢的歌 \+ 2 首推荐/);
    assert.ok(env.snapshotValue(), '原队列存进快照，退出/重启时还要还原');

    const url = env.fetchCalls[0];
    assert.match(url, /\/playmode\/intelligence\/list/);
    assert.match(url, new RegExp(`[?&]id=${ids[1]}\\b`), '用随机喜欢的那首当种子');
    assert.match(url, new RegExp(`[?&]sid=${ids[1]}\\b`));
    assert.match(url, /[?&]pid=liked-1\b/);
    assert.match(url, /[?&]cookie=session-cookie\b/);
    assert.match(url, /[?&]count=2\b/);
});

test('私人 FM 模式下开启：先切回普通队列，FM 分支才不会绕开心动队列', async () => {
    const env = createEnv({ fmMode: true, endpoint: pairEndpoint(101) });
    activate(env.folium);
    await runStart(env);
    await tick(80);
    assert.equal(env.store.getState().isFmMode, false);
    const ids = idsOf(env.store.getState().playQueue);
    assert.equal(ids[0], 12);
    assert.deepEqual(ids.slice(2, 4), [101, 102]);
    assert.ok(!ids.includes(11) && !ids.includes(13));
});

test('准备中再点一下：立刻取消，队列一动不动', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const env = createEnv({ endpoint: () => gate.then(() => heartbeatPayload(101, 102)) });
    activate(env.folium);
    const { button } = mountButton(env);

    button.click();
    assert.equal(button.attributes['aria-busy'], 'true');
    button.click();   // 第二下：取消
    assert.equal(button.attributes['aria-busy'], 'false', '取消也是同步生效');
    assert.match(env.toasts.at(-1).message, /已取消/);
    assert.deepEqual(idsOf(env.store.getState().playQueue), [11, 12, 13]);

    release();        // 让被取消的那次准备流程走完
    await tick(80);
    assert.deepEqual(idsOf(env.store.getState().playQueue), [11, 12, 13], '取消后接口回来也不许动队列');
    assert.equal(env.snapshotValue(), null, '取消也要把快照清掉');
    assert.equal(await runStop(env), '心动模式没有在运行');
});

// ---------------------------------------------------------------- 无限循环（核心）

test('无限循环：一直播下去永远是 1 喜欢 + 2 推荐，绝不掉回原喜欢列表', async () => {
    const env = createEnv({
        endpoint: pairEndpoint(101),
        // 用户当前队列就是「我喜欢的音乐」本身：这正是之前出 bug 的场景。
        queue: [21, 22, 23, 24, 25, 26, 27, 28, 29, 30].map((id) => song(id)),
        currentSong: song(25),
    });
    activate(env.folium);
    await runStart(env);
    await tick(120);

    const played = [25];
    for (let step = 0; step < 30; step += 1) {
        const queue = env.store.getState().playQueue;
        assertHeartbeatQueue(queue);
        assert.equal(new Set(idsOf(queue)).size, idsOf(queue).length, '同一首歌不许在队列里出现两次');
        const next = playNext(env);
        played.push(next.id);
        await tick(40);   // 给 runway 一点补组时间
    }

    // 播放顺序：1 喜欢 + 2 推荐，一组接一组。
    for (let index = 1; index < played.length; index += 1) {
        const id = played[index];
        const positionInGroup = (index - 1) % 3;
        if (positionInGroup === 0) {
            assert.ok([21, 22, 23, 24, 25, 26, 27, 28, 29, 30].includes(id), `第 ${index} 首应该是喜欢的歌，实际 ${id}`);
        } else {
            assert.ok(id >= 101, `第 ${index} 首应该是推荐，实际 ${id}`);
        }
    }
    // 原队列里除了正在放的那首（25），其它歌只可能以「心动喜欢的歌」的身份重新出现，
    // 不可能夹带着原列表顺序回来——这一点由每拍的 assertHeartbeatQueue（key 唯一）兜住。
    const finalQueue = env.store.getState().playQueue;
    assert.ok(finalQueue.length <= 24, `队列不该无限变长（现在 ${finalQueue.length} 首）`);
    assert.ok(countOwnedAhead(finalQueue, env.store.getState().currentSong) >= 1, '跑道不能空');
});

test('跑道：当前歌后面始终保持至少 9 首心动歌', async () => {
    const env = createEnv({ endpoint: pairEndpoint(101) });
    activate(env.folium);
    await runStart(env);
    await tick(120);
    assert.ok(countOwnedAhead(env.store.getState().playQueue, env.store.getState().currentSong) >= 9);

    playNext(env);
    await tick(80);
    playNext(env);
    await tick(80);
    const ahead = countOwnedAhead(env.store.getState().playQueue, env.store.getState().currentSong);
    assert.ok(ahead >= 9, `切歌后跑道要立刻补回 9 首，实际 ${ahead}`);
});

// ---------------------------------------------------------------- 推荐接口的兼容

test('老后端忽略 count（一次只回一首）：补第二次，一组仍然凑够两首推荐', async () => {
    const env = createEnv({ endpoint: onePerCallEndpoint(101) });
    activate(env.folium);
    await runStart(env);
    await tick(120);
    const ids = idsOf(env.store.getState().playQueue);
    assert.deepEqual(ids.slice(2, 4), [101, 102], '两首推荐都拿到了');
    assert.ok(env.fetchCalls.length >= 2, '打了两次接口');
    assert.match(env.fetchCalls[0], /[?&]count=2\b/);
    assert.match(env.fetchCalls[1], /[?&]count=1\b/, '第二次只要缺的那一首');
});

test('上游一直回同一首：不再重复打接口，用私人 FM 补第二首', async () => {
    const env = createEnv({ endpoint: stuckEndpoint(101), fm: [[song(301)]] });
    activate(env.folium);
    await runStart(env);
    await tick(120);
    const ids = idsOf(env.store.getState().playQueue);
    assert.deepEqual(ids.slice(2, 4), [101, 301]);
    // 第一首 101 之后上游一直重复，最多打 MAX_REC_CALLS=3 次就收手（含后续补组，放宽到 4）。
    assert.ok(env.fetchCalls.length <= 4, `不该无限重试，实际 ${env.fetchCalls.length} 次`);
});

test('心动接口不可用（非 JSON）：私人 FM 顶上', async () => {
    const env = createEnv({ endpoint: () => '<html>502</html>', fm: [[song(301), song(302)]] });
    activate(env.folium);
    await runStart(env);
    await tick(120);
    const ids = idsOf(env.store.getState().playQueue);
    assert.deepEqual(ids.slice(2, 4), [301, 302]);
});

test('接口和私人 FM 都给不出歌：开启失败，队列一动不动', async () => {
    const env = createEnv({ endpoint: () => heartbeatPayload() });
    activate(env.folium);
    const { button } = mountButton(env);
    const result = await runStart(env);
    assert.match(String(result), /没有给出推荐/);
    assert.match(env.toasts.at(-1).message, /没有给出推荐/);
    assert.deepEqual(idsOf(env.store.getState().playQueue), [11, 12, 13]);
    assert.equal(env.snapshotValue(), null);
    assert.equal(button.attributes['aria-pressed'], 'false', '失败后按钮回到空闲');
});

test('推荐里混着下架歌曲：跳过下架那首，仍然凑两首能播的', async () => {
    const env = createEnv({ endpoint: pairEndpoint(101), offShelf: [102] });
    activate(env.folium);
    await runStart(env);
    await tick(120);
    const ids = idsOf(env.store.getState().playQueue);
    assert.deepEqual(ids.slice(2, 4), [101, 103]);
});

test('当前歌不是网易云的：照样接管队列，队首保留它', async () => {
    const env = createEnv({
        currentSong: song('K1', 'kugou'),
        queue: [song(11), song('K1', 'kugou'), song(13)],
        endpoint: pairEndpoint(101),
    });
    activate(env.folium);
    await runStart(env);
    await tick(120);
    const queue = env.store.getState().playQueue;
    assert.equal(queue[0].id, 'K1');
    assert.notEqual(playbackKey(queue[0]), playbackKey(queue[1]));
    assertHeartbeatQueue(queue);
});

// ---------------------------------------------------------------- 前置条件

test('没登录 / 没在播的歌：给出提示且不动队列', async () => {
    const anonymous = createEnv({ loggedIn: false });
    activate(anonymous.folium);
    assert.match(String(await runStart(anonymous)), /登录/);
    assert.deepEqual(idsOf(anonymous.store.getState().playQueue), [11, 12, 13]);

    const idle = createEnv({ currentSong: null, queue: [] });
    activate(idle.folium);
    assert.match(String(await runStart(idle)), /没有在播的歌/);
});

// ---------------------------------------------------------------- 退出 / 还原

test('退出：恢复开启前的队列，从开启时那首的后面接起，移除心动歌', async () => {
    const env = createEnv({ endpoint: pairEndpoint(101), currentSong: song(12), queue: [11, 12, 13].map((id) => song(id)) });
    activate(env.folium);
    await runStart(env);
    await tick(120);
    const playing = playNext(env);   // 播到第一首喜欢
    await tick(40);

    const result = await runStop(env);
    assert.match(String(result), /已退出/);
    // restoreQueue(当前歌, [11,12,13], 锚点 12) → [当前歌, 13, 11, 12]
    const ids = idsOf(env.store.getState().playQueue);
    assert.equal(ids.length, 4);
    assert.equal(ids[0], playing.id, '当前正在放的那首留着，不打断播放');
    assert.deepEqual(ids.slice(1), [13, 11, 12], '原来的队列按锚点之后接回去');
    assert.equal(env.snapshotValue(), null, '退出后快照要清掉');
    assert.match(env.toasts.at(-1).message, /恢复开启前的队列/);
    assert.equal(await runStop(env), '心动模式没有在运行');
});

test('进度条按钮：开着的时候再点一下就是退出并还原；停用模组也还原', async () => {
    const env = createEnv({ endpoint: pairEndpoint(101) });
    const dispose = activate(env.folium);
    const { button } = mountButton(env);
    button.click();
    await tick(120);
    assert.equal(button.attributes['aria-pressed'], 'true');

    button.click();
    await tick(40);
    assert.equal(button.attributes['aria-pressed'], 'false');
    const ids = idsOf(env.store.getState().playQueue);
    assert.deepEqual([...ids].sort((a, b) => Number(a) - Number(b)), [11, 12, 13]);

    // 再开一次，然后直接停用模组
    await runStart(env);
    await tick(120);
    assert.equal(env.store.getState().playQueue.length > 3, true);
    dispose();
    await tick(40);
    const restored = idsOf(env.store.getState().playQueue);
    assert.equal(restored.includes(101), false, '停用后不许留下心动歌');
    assert.ok(restored.length >= 3);
});

test('用户自己换了队列：心动模式自动收摊，尊重用户的新队列', async () => {
    const env = createEnv({ endpoint: pairEndpoint(101) });
    activate(env.folium);
    const { button } = mountButton(env);
    await runStart(env);
    await tick(120);
    assert.equal(button.attributes['aria-pressed'], 'true');

    env.store.getState().setPlayQueue([song(31), song(32)]);
    env.store.setState({ currentSong: song(31) });
    await tick(60);

    assert.deepEqual(idsOf(env.store.getState().playQueue), [31, 32], '用户的新队列不许被改');
    assert.equal(button.attributes['aria-pressed'], 'false', '按钮回空闲');
    assert.equal(env.snapshotValue(), null);
    assert.match(env.toasts.at(-1).message, /已退出/);
});

test('宿主被关掉后重开：用快照把队列还原，别把心动歌留在「我喜欢的音乐」里', async () => {
    const env = createEnv({
        snapshot: [song(11), song(12), song(13)],
        currentSong: song(12),
        queue: [song(12), song(21), song(101), song(102)],
        endpoint: pairEndpoint(101),
    });
    activate(env.folium);
    await tick(1600);   // 700ms 换回去，再看一拍确认宿主没抢回去才收快照
    assert.deepEqual(idsOf(env.store.getState().playQueue), [11, 12, 13]);
    assert.equal(env.snapshotValue(), null, '还原成功后快照就该收掉');

    // 还原之后用户点开启，一样正常工作。
    await runStart(env);
    await tick(120);
    const ids = idsOf(env.store.getState().playQueue);
    assert.equal(ids[0], 12);
    assert.ok(env.likedSongs.some((entry) => entry.id === ids[1]));
    assert.deepEqual(ids.slice(2, 4), [101, 102]);
});

// ---------------------------------------------------------------- 随机抽歌

test('喜欢的歌很多：随机翻页，不会永远从第一首开始', async () => {
    const many = Array.from({ length: 200 }, (_value, index) => song(1000 + index));
    const env = createEnv({ likedSongs: many, likedTotal: 200, endpoint: pairEndpoint(101) });
    const originalRandom = Math.random;
    Math.random = () => 0.99;   // 固定随机数：offset 应该落在 150
    try {
        activate(env.folium);
        await runStart(env);
        await tick(120);
    } finally {
        Math.random = originalRandom;
    }
    assert.equal(env.pageCalls[0].limit, 50);
    // randomInt(200-50+1) = floor(0.99 * 151) = 149
    assert.equal(env.pageCalls[0].offset, 149, '随机 offset 落在 total-50 之内');
    const ids = idsOf(env.store.getState().playQueue);
    assert.ok(ids[1] >= 1149, `喜欢取自随机那一页，实际 ${ids[1]}`);
});

// ---------------------------------------------------------------- 跑

let failed = 0;
for (const { name, fn } of tests) {
    try {
        await fn();
        console.log(`ok   ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`FAIL ${name}`);
        console.log(`     ${error?.message}`);
    }
}
console.log(`\n${tests.length - failed}/${tests.length} 通过`);
if (failed > 0) process.exitCode = 1;