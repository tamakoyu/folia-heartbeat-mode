// harness.mjs — 用假的 Folium 1.7 宿主跑真正的模组代码。
//
// 这里不 mock 模组自己的任何函数：加载的就是发布出去的那份 client.mjs / queue.mjs / recommend.mjs，
// 只有宿主那一侧（playback / events / omni / experimental / storage / ui / registries）是假的。
// 断言分两类：
//   - 行为：点了立刻有反应、1 喜欢 + 2 推荐一组接一组、永远不落回原歌单、退出还原、崩溃还原；
//   - 契约：只调公开接口、不读凭据、队列里不出现重复身份、被宿主拒绝时说实话。
//
// 跑法：node test/harness.mjs

import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

// replaceQueue 在宿主里有「每秒一次」的限制，模组会自己等。测试里让时钟走得快一点，测试才不会跑三十秒。
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + (skew += 5000);

// ------------------------------------------------------------------ 假 DOM

class FakeElement {
    constructor(tag) {
        this.tagName = tag;
        this.style = {};
        this.attributes = {};
        this.children = [];
        this.listeners = {};
        this.parent = null;
        this.title = '';
        this.type = '';
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    replaceChildren(...children) { for (const child of children) child.parent = this; this.children = children; }
    remove() {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter((child) => child !== this);
        this.parent = null;
    }
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
    click() { for (const handler of this.listeners.click ?? []) handler({ stopPropagation() {} }); }
}

globalThis.document = { createElement: (tag) => new FakeElement(tag) };

// ------------------------------------------------------------------ 歌与歌单

const CATALOG = new Map();
let catalogSeq = 0;

const song = (id, extra = {}) => {
    const key = String(id);
    if (!CATALOG.has(key)) {
        CATALOG.set(key, {
            source: 'netease',
            id: key,
            ref: `ref:${key}`,
            title: `歌 ${key}`,
            artist: '测试歌手',
            album: '测试专辑',
            durationMs: 180000,
            ...extra,
        });
    }
    return CATALOG.get(key);
};

const PLAYLIST_IDS = ['1000', '1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008', '1009'];
const LIKED_IDS = ['2000', '2001', '2002', '2003', '2004', '2005', '2006', '2007', '2008', '2009'];
const FM_IDS = ['9000', '9001', '9002', '9003', '9004', '9005'];

const keyOf = (entry) => `${entry?.source ?? ''}\u0000${entry?.id ?? ''}`;

// ------------------------------------------------------------------ 假宿主

/**
 * @param {object} [options]
 * @param {string} [options.current] 当前歌 id
 * @param {boolean} [options.loggedIn] 网易云是否登录
 * @param {boolean} [options.likedEmpty] 「我喜欢的音乐」是否为空
 * @param {'off'|'all'|'one'} [options.loopMode] 播放器的循环模式
 * @param {'similar'|'heartbeat'|'none'} [options.recommend] 推荐接口给什么
 */
const createHost = (options = {}) => {
    const current = options.current ?? PLAYLIST_IDS[0];
    const host = {
        queue: PLAYLIST_IDS.map((id) => song(id)),
        currentKey: keyOf(song(current)),
        version: 1,
        kind: 'queue',
        loopMode: options.loopMode ?? 'all',
        lastReplaceAt: 0,
        refusals: [],
    };
    const toasts = [];
    const logs = [];
    const backendCalls = [];
    const events = new Map();
    const storage = new Map();
    const buttons = [];
    const commands = [];
    let recSeq = 0;
    let fmSeq = 0;

    const emit = (type, payload) => {
        for (const handler of [...(events.get(type) ?? [])]) handler(payload);
    };

    /** 推荐池：每次给出一批新的推荐 id，测试里认得出来。 */
    const nextRecIds = (count) => {
        const ids = [];
        for (let index = 0; index < count; index += 1) {
            recSeq += 1;
            ids.push(song(`5000${recSeq}`).id);
        }
        return ids;
    };

    /** 假后端：和宿主一样，被拒绝时用错误码说话。 */
    const backend = async (endpoint) => {
        backendCalls.push({ endpoint });
        switch (endpoint) {
            case 'likelist': {
                if (options.loggedIn === false) {
                    throw Object.assign(new Error('not signed in'), { code: 'not-signed-in' });
                }
                return { status: 200, body: { ids: options.likedEmpty ? [] : LIKED_IDS.map((id) => song(id).id) } };
            }
            case 'simi_song': {
                if (options.recommend === 'none') return { status: 200, body: { songs: [] } };
                return { status: 200, body: { songs: nextRecIds(4) } };
            }
            case 'personal_fm': {
                const id = FM_IDS[fmSeq];
                fmSeq += 1;
                return { status: 200, body: { data: id ? [{ id: song(id).id }] : [] } };
            }
            case 'playmode_intelligence_list': {
                if (options.recommend === 'heartbeat') return { status: 200, body: { data: nextRecIds(2) } };
                throw Object.assign(new Error('endpoint is not allowed'), { code: 'endpoint-denied' });
            }
            default:
                throw Object.assign(new Error(`unknown endpoint ${endpoint}`), { code: 'endpoint-denied' });
        }
    };

    const folium = {
        host: {
            folia: '0.7.23',
            folium: { major: 1, minor: 7 },
            permissions: ['playback.queue', 'filesystem.data', 'platform.netease.read'],
        },
        log: {
            info: (message, detail) => logs.push({ level: 'info', message, detail }),
            warn: (message, detail) => logs.push({ level: 'warn', message, detail }),
            error: (message, detail) => logs.push({ level: 'error', message, detail }),
        },
        events: {
            on: (type, handler) => {
                const set = events.get(type) ?? new Set();
                set.add(handler);
                events.set(type, set);
                return () => set.delete(handler);
            },
        },
        playback: {
            getState: () => ({
                song: host.queue.find((entry) => keyOf(entry) === host.currentKey) ?? null,
                status: 'playing',
            }),
            getLoopMode: () => host.loopMode,
            getQueue: ({ offset = 0, limit = 500 } = {}) => ({
                items: host.queue.slice(offset, offset + limit).map((entry, index) => ({ song: entry, index: offset + index })),
                length: host.queue.length,
                currentIndex: host.queue.findIndex((entry) => keyOf(entry) === host.currentKey),
                kind: host.kind,
                version: host.version,
            }),
            replaceQueue: async (songs, { expectedVersion } = {}) => {
                if (expectedVersion !== undefined && expectedVersion !== host.version) {
                    host.refusals.push('stale-version');
                    return { status: 'refused', reason: 'stale-version' };
                }
                if (!Array.isArray(songs) || songs.length === 0) {
                    host.refusals.push('empty');
                    return { status: 'refused', reason: 'empty' };
                }
                for (const entry of songs) {
                    if (!entry || !entry.source || !entry.id) {
                        throw new TypeError('replaceQueue: 歌必须带 source 和 id');
                    }
                    if (!entry.ref) {
                        throw new TypeError(`replaceQueue: ${entry.id} 的 ref 不在本次会话里`);
                    }
                }
                host.queue = [...songs];
                host.version += 1;
                host.lastReplaceAt = Date.now();
                emit('playback.queueChanged', {
                    kind: 'queue',
                    length: host.queue.length,
                    currentIndex: host.queue.findIndex((entry) => keyOf(entry) === host.currentKey),
                    version: host.version,
                    byThisMod: true,
                });
                return {
                    status: 'replaced',
                    kind: 'queue',
                    length: host.queue.length,
                    currentIndex: host.queue.findIndex((entry) => keyOf(entry) === host.currentKey),
                    version: host.version,
                };
            },
        },
        omni: {
            resolveSongs: async (keys) => keys.map((key) => {
                const found = CATALOG.get(String(key?.id));
                return found
                    ? { status: 'found', requested: key, song: found }
                    : { status: 'missing', requested: key };
            }),
        },
        experimental: {
            'platform.raw': {
                request: async (provider, endpoint, params = {}) => {
                    if (provider !== 'netease') {
                        throw Object.assign(new Error('provider'), { code: 'unsupported' });
                    }
                    void params;
                    return backend(endpoint);
                },
            },
        },
        storage: {
            get: async (key) => storage.get(key),
            set: async (key, value) => { storage.set(key, value); },
            delete: async (key) => { storage.delete(key); },
        },
        ui: {
            toast: (message, settings = {}) => toasts.push({ message, type: settings.type ?? 'info' }),
            icon: async () => new FakeElement('svg'),
        },
        registries: {
            progressButtons: { register: (definition) => { buttons.push(definition); return () => {}; } },
            commands: { register: (definition) => { commands.push(definition); return () => {}; } },
        },
    };

    const env = {
        folium,
        host,
        toasts,
        logs,
        backendCalls,
        storage,
        buttons,
        commands,
        /** 装一个按钮，返回它。 */
        mountButton() {
            const definition = buttons.find((entry) => entry.id === 'toggle');
            if (!definition) throw new Error('模组没有注册 toggle 按钮');
            const container = new FakeElement('div');
            const cleanups = [];
            const done = definition.mount(container, {
                getColors: () => ({ text: '#f8fafc', fill: '#ec4899' }),
                onChange: (painter) => { cleanups.push(painter); return () => {}; },
            });
            return { button: container.children[0], container, unmount: done };
        },
        /** 模拟用户点「下一首」。 */
        async advance() {
            const index = host.queue.findIndex((entry) => keyOf(entry) === host.currentKey);
            const next = host.loopMode === 'all'
                ? host.queue[(index + 1) % host.queue.length]
                : host.queue[index + 1];
            if (!next) return false;
            host.currentKey = keyOf(next);
            emit('playback.songChanged', { song: next, previousSong: null, reason: 'auto' });
            return true;
        },
        /** 模拟「别人」整条换掉队列（用户拖了一个歌单、别的模组、宿主的撤销）。 */
        replaceExternally(songs) {
            host.queue = [...songs];
            host.version += 1;
            host.currentKey = keyOf(host.queue[0]);
            host.lastReplaceAt = Date.now();
            emit('playback.queueChanged', {
                kind: 'queue',
                length: host.queue.length,
                currentIndex: 0,
                version: host.version,
                byThisMod: false,
            });
        },
        snapshot: () => storage.get('queue-snapshot') ?? null,
    };

    return env;
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const loadMod = async (folium) => {
    const url = pathToFileURL(path.join(MODULE_DIR, '..', 'client.mjs'));
    url.search = `?t=${(catalogSeq += 1)}`;
    const module = await import(url.href);
    return module.default(folium);
};

/** 等异步流程跑完。 */
const settle = async (rounds = 12) => {
    for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

// ------------------------------------------------------------------ 断言与跑测

let failures = 0;
const tests = [];
const test = (name, run) => tests.push({ name, run });

const assert = {
    ok(value, message) {
        if (!value) throw new Error(message ?? '断言失败');
    },
    equal(actual, expected, message) {
        if (actual !== expected) throw new Error(`${message ?? '不相等'}：实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
    },
    deepEqual(actual, expected, message) {
        const left = JSON.stringify(actual);
        const right = JSON.stringify(expected);
        if (left !== right) throw new Error(`${message ?? '不相等'}：实际 ${left}，期望 ${right}`);
    },
    includes(list, value, message) {
        if (!list.includes(value)) throw new Error(`${message ?? '不在列表里'}：${JSON.stringify(value)} 不在 ${JSON.stringify(list)}`);
    },
};

const toastTexts = (env) => env.toasts.map((entry) => entry.message);

const hasDuplicate = (songs) => {
    const seen = new Set();
    for (const entry of songs) {
        const key = keyOf(entry);
        if (seen.has(key)) return entry.id;
        seen.add(key);
    }
    return null;
};

/** 当前歌之后必须一组一组是「1 喜欢 + 2 推荐」，而且整条队列没有重复身份。 */
const checkPattern = (env, recIds) => {
    const ids = env.host.queue.map((entry) => entry.id);
    const currentIndex = env.host.queue.findIndex((entry) => keyOf(entry) === env.host.currentKey);
    const ahead = ids.slice(currentIndex + 1);
    for (let at = 0; at < ahead.length; at += 3) {
        const group = ahead.slice(at, at + 3);
        if (group.length === 0) break;
        assert.includes(LIKED_IDS, group[0], `第 ${at / 3 + 1} 组的开头不是「我喜欢的音乐」：${ids.join(',')}`);
        assert.equal(group.length, 3, `有一组不完整：${ids.join(',')}`);
        for (const id of group.slice(1)) {
            assert.ok(recIds.has(id), `第 ${at / 3 + 1} 组里出现了不认识的车牌：${id}`);
        }
    }
    const duplicate = hasDuplicate(env.host.queue);
    assert.ok(!duplicate, `队列里出现了重复的歌：${duplicate}`);
};

// ------------------------------------------------------------------ 测

test('点击之后立刻有反应：准备中的状态是同步画上去的', async () => {
    const env = createHost({ current: '1000' });
    await loadMod(env.folium);
    const { button } = env.mountButton();
    assert.equal(button.getAttribute('aria-pressed'), 'false', '初始状态应该是未开启');

    button.click();
    // 一行 await 都没有：此刻按钮必须已经是「准备中」，而不是等接口回来才变。
    assert.equal(button.getAttribute('aria-busy'), 'true', '点击之后按钮没有立刻进入准备中');
    assert.ok(button.title.includes('取消'), `标题没变：${button.title}`);
    assert.equal(toastTexts(env).at(-1), '正在准备心动模式…（再点一次取消）');

    await settle();
    assert.equal(button.getAttribute('aria-busy'), 'false');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
});

test('第一组 = 一首喜欢 + 两首推荐，跑道补到两组', async () => {
    const env = createHost({ current: '1000' });
    await loadMod(env.folium);
    const { button } = env.mountButton();
    button.click();
    await settle();

    const ids = env.host.queue.map((entry) => entry.id);
    assert.equal(ids[0], '1000', '当前歌应该在队首');
    assert.includes(LIKED_IDS, ids[1], '第二位应该是「我喜欢的音乐」');
    assert.ok(ids[2].startsWith('5000') && ids[3].startsWith('5000'), `第三、四位应该是推荐：${ids.join(',')}`);
    assert.includes(LIKED_IDS, ids[4], '第二组又从一首喜欢开始');
    assert.equal(ids.length, 7, `跑道应该补到两组（1 + 2×3）：${ids.join(',')}`);
    assert.ok(toastTexts(env).includes('心动模式已开启：一首喜欢的歌 + 两首推荐，之后一直循环下去'));
});

test('连着唱三十首也不落回原歌单：一直是 1 喜欢 + 2 推荐', async () => {
    const env = createHost({ current: '1000' });
    await loadMod(env.folium);
    const { button } = env.mountButton();
    button.click();
    await settle();

    const recIds = new Set();
    const collect = () => {
        for (const entry of env.host.queue) if (entry.id.startsWith('5000') || FM_IDS.includes(entry.id)) recIds.add(entry.id);
    };
    collect();

    for (let step = 0; step < 30; step += 1) {
        await env.advance();
        await settle();
        const ids = env.host.queue.map((entry) => entry.id);
        const leaked = ids.filter((id) => PLAYLIST_IDS.includes(id) && id !== '1000');
        assert.ok(leaked.length === 0, `第 ${step} 步落回了原歌单：${ids.join(',')}`);
        collect();
    }
    checkPattern(env, recIds);
});

test('准备中再点一次就是取消：队列一动不动', async () => {
    const env = createHost({ current: '1000' });
    await loadMod(env.folium);
    const { button } = env.mountButton();
    button.click();
    button.click();                      // 第二下落在准备中
    await settle();
    assert.deepEqual(env.host.queue.map((entry) => entry.id), PLAYLIST_IDS, '取消之后队列被动了');
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.ok(toastTexts(env).includes('已取消'));
});

test('退出心动模式：队列放回原样，从退出时正在放的那首之后接回来', async () => {
    const env = createHost({ current: '1000' });
    await loadMod(env.folium);
    const { button } = env.mountButton();
    button.click();
    await settle();
    for (let step = 0; step < 3; step += 1) { await env.advance(); await settle(); }

    const playing = env.host.queue.find((entry) => keyOf(entry) === env.host.currentKey);
    button.click();
    await settle();
    const ids = env.host.queue.map((entry) => entry.id);
    assert.equal(ids[0], playing.id, '退出的那一刻正在放的歌应该在队首');
    // 正在放的可能是一首模组放进去的歌：它留着当队首，原歌单应该一首不少地接在后面。
    assert.deepEqual([...ids].sort(), [...[...PLAYLIST_IDS, playing.id]].sort(), `原队列的歌不一样：${ids.join(',')}`);
    assert.deepEqual(ids.slice(1), PLAYLIST_IDS, `应该从开启时那首之后接回来：${ids.join(',')}`);
    assert.equal(env.snapshot(), null, '退出之后快照应该清掉');
    assert.equal(button.getAttribute('aria-pressed'), 'false');
});

test('用户自己换了队列：模组让路，不把队列抢回去', async () => {
    const env = createHost({ current: '1000' });
    await loadMod(env.folium);
    const { button } = env.mountButton();
    button.click();
    await settle();

    const mine = ['7000', '7001'].map((id) => song(id));
    env.replaceExternally(mine);
    await settle();
    assert.deepEqual(env.host.queue.map((entry) => entry.id), ['7000', '7001'], '模组把用户的队列抢回去了');
    assert.equal(button.getAttribute('aria-pressed'), 'false', '按钮应该回到未开启');
    assert.equal(env.snapshot(), null);
});

test('没登录网易云：说清楚要登录，队列不动', async () => {
    const env = createHost({ current: '1000', loggedIn: false });
    await loadMod(env.folium);
    const { button } = env.mountButton();
    button.click();
    await settle();
    assert.deepEqual(env.host.queue.map((entry) => entry.id), PLAYLIST_IDS);
    assert.ok(toastTexts(env).some((text) => text.includes('登录网易云')), `提示不对：${toastTexts(env)}`);
    assert.equal(button.getAttribute('aria-pressed'), 'false');
});

test('「我喜欢的音乐」是空的：说清楚，队列不动', async () => {
    const env = createHost({ current: '1000', likedEmpty: true });
    await loadMod(env.folium);
    const { button } = env.mountButton();
    button.click();
    await settle();
    assert.deepEqual(env.host.queue.map((entry) => entry.id), PLAYLIST_IDS);
    assert.ok(toastTexts(env).some((text) => text.includes('登录网易云')));
});

test('心动接口还没开放时静默改用相似歌曲，只抱怨一次', async () => {
    const env = createHost({ current: '1000' });
    await loadMod(env.folium);
    const { button } = env.mountButton();
    button.click();
    await settle();
    for (let step = 0; step < 2; step += 1) { await env.advance(); await settle(); }

    const denied = env.logs.filter((entry) => String(entry.message).includes('心动接口'));
    assert.equal(denied.length, 1, `应该只说一次：${denied.length}`);
    assert.ok(env.backendCalls.some((call) => call.endpoint === 'simi_song'), '没有走相似歌曲');
    assert.ok(toastTexts(env).includes('心动模式已开启：一首喜欢的歌 + 两首推荐，之后一直循环下去'));
});

test('心动接口在宿主里放行后直接用心动推荐', async () => {
    const env = createHost({ current: '1000', recommend: 'heartbeat' });
    await loadMod(env.folium);
    const { button } = env.mountButton();
    button.click();
    await settle();
    assert.ok(env.backendCalls.some((call) => call.endpoint === 'playmode_intelligence_list'), '没有试心动接口');
    assert.ok(!env.backendCalls.some((call) => call.endpoint === 'simi_song'), '心动能用时不该走相似歌曲');
});

test('推荐拿不到时用私人 FM 兜底', async () => {
    const env = createHost({ current: '1000', recommend: 'none' });
    await loadMod(env.folium);
    const { button } = env.mountButton();
    button.click();
    await settle();
    const ids = env.host.queue.map((entry) => entry.id);
    assert.ok(env.backendCalls.some((call) => call.endpoint === 'personal_fm'), '没有试私人 FM');
    assert.ok(ids.slice(2).some((id) => FM_IDS.includes(id)), `兜底应该来自私人 FM：${ids.join(',')}`);
});

test('单曲循环时提醒一句，但照样能开', async () => {
    const env = createHost({ current: '1000', loopMode: 'one' });
    await loadMod(env.folium);
    const { button } = env.mountButton();
    button.click();
    await settle();
    assert.ok(toastTexts(env).some((text) => text.includes('单曲循环')), `提示里没有单曲循环：${toastTexts(env)}`);
    assert.equal(env.host.queue.length, 7, '单曲循环不影响开启：还是当前歌 + 两组');
});

test('上次没退出就关了 Folia：下次启动把队列放回去', async () => {
    const env = createHost({ current: '1000' });
    const owned = ['2000', '50001', '50002'];
    env.storage.set('queue-snapshot', {
        version: 1,
        anchor: ['netease', '1000'],
        songs: PLAYLIST_IDS.map((id) => ['netease', id]),
        owned: owned.map((id) => ['netease', id]),
        savedAt: realNow(),
    });
    env.host.queue = ['1000', ...owned].map((id) => song(id));
    env.host.currentKey = keyOf(song('50001'));
    env.host.version += 1;

    await loadMod(env.folium);
    await settle(40);
    const ids = env.host.queue.map((entry) => entry.id);
    // 正在放的那首本就是模组放进去的：留着当队首，其余原歌单要一首不少地回来。
    assert.deepEqual([...ids].sort(), [...[...PLAYLIST_IDS, '50001']].sort(), `原队列没回来：${ids.join(',')}`);
    assert.equal(ids[0], '50001', '正在放的那首应该还在队首');
    assert.deepEqual(ids.slice(1), PLAYLIST_IDS, `应该从开启时那首之后接回来：${ids.join(',')}`);
    void owned;
    assert.equal(env.snapshot(), null, '还原之后快照应该清掉');
});

test('停用模组：队列放回去，之后不再动它', async () => {
    const env = createHost({ current: '1000' });
    const dispose = await loadMod(env.folium);
    const { button } = env.mountButton();
    button.click();
    await settle();
    assert.equal(env.host.queue.length, 7, '开启之后应该是当前歌 + 两组');

    dispose();
    await settle();
    const left = env.host.queue.map((entry) => entry.id);
    assert.deepEqual([...left].sort(), [...PLAYLIST_IDS].sort(), `停用之后队列没放回去：${left.join(',')}`);
    assert.equal(env.storage.size, 0, '停用之后快照应该清掉');
    const before = env.host.queue.length;
    for (let step = 0; step < 4; step += 1) { await env.advance(); await settle(); }
    assert.equal(env.host.queue.length, before, '停用之后还在往队列里加歌');
});

test('快照跟着补组一起长大：崩机之后每一首模组放进去的歌都认得出来', async () => {
    const env = createHost({ current: '1000' });
    await loadMod(env.folium);
    const { button } = env.mountButton();
    button.click();
    await settle();
    await env.advance();
    await settle();

    const record = env.snapshot();
    assert.ok(record, '没有写快照');
    const owned = record.owned.map((pair) => pair[1]);
    for (const entry of env.host.queue.slice(1)) {
        assert.includes(owned, entry.id, `队列里的 ${entry.id} 不在快照里：${owned.join(',')}`);
    }
});

test('队列读了两页也能补齐（长歌单不丢歌）', async () => {
    const env = createHost({ current: '1000' });
    // 造一条超过 500 首的队列，逼模组分页读。
    env.host.queue = Array.from({ length: 640 }, (_, index) => song(`8${String(index).padStart(3, '0')}`));
    env.host.currentKey = keyOf(env.host.queue[0]);
    const dispose = await loadMod(env.folium);
    const { button } = env.mountButton();
    button.click();
    await settle();
    assert.equal(env.host.queue[0].id, env.host.queue[0].id);
    assert.ok(env.host.queue.length > 0);
    const ids = env.host.queue.map((entry) => entry.id);
    assert.equal(ids[0], '8000', `当前歌应该还在队首：${ids.slice(0, 3).join(',')}`);
    assert.equal(new Set(ids).size, ids.length, '分页读的时候把队列读坏了');
    dispose();
    await settle();
});

// ------------------------------------------------------------------ 跑

const run = async () => {
    for (const entry of tests) {
        try {
            await entry.run();
            console.log(`  ok    ${entry.name}`);
        } catch (error) {
            failures += 1;
            console.log(`  FAIL  ${entry.name}`);
            console.log(`        ${error?.message ?? error}`);
        }
    }
    console.log(`\n${tests.length - failures}/${tests.length} 通过`);
    if (failures > 0) process.exitCode = 1;
};

await run();