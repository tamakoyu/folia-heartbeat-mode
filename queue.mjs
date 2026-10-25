// queue.mjs
// 心动模式队列的纯函数部分：开启后整条播放队列由模组接管——队首是正在放的那首，
// 后面只有「1 首随机喜欢 + 2 首推荐」一组接一组。用户原来的队列存成快照，退出时还原。
// 只碰数组，不碰 store，方便单独验证。

/** 与宿主 getPlaybackSongKey 完全一致的播放身份（对不上会让重复歌在队列里错位）。 */
const sourceRefOf = (song) => {
    if (!song) return null;
    if (song.sourceRef) return song.sourceRef;
    if (song.isStage) return { kind: 'stage', mediaId: String(song.id) };
    if (song.isLocal && song.localRef?.songId) return { kind: 'local', mediaId: song.localRef.songId };
    if (song.isNavidrome) {
        const carrier = song.navidromeData?.isNavidrome ? song.navidromeData : song;
        return { kind: 'navidrome', mediaId: String(carrier?.navidromeData?.id || song.id) };
    }
    return { kind: 'online', providerId: song.providerId || 'netease', mediaId: String(song.id) };
};

export const playbackKey = (song) => {
    const ref = sourceRefOf(song);
    if (!ref) return '';
    return ref.kind === 'online'
        ? `online:${ref.providerId}:${ref.mediaId}`
        : `${ref.kind}:${ref.mediaId}`;
};

/**
 * 开启：当前歌留在队首继续放，后面接第一组。
 * 用户原来的队列不进播放队列（避免重复 key 让宿主从错误的拷贝切歌），只进快照。
 */
export const buildHeartbeatQueue = (currentSong, group) => (
    currentSong ? [currentSong, ...(group ?? [])] : [...(group ?? [])]
);

/** 续拉：直接接到队尾。整条队列都是心动歌，永远不会混进用户原队列的歌。 */
export const appendGroup = (queue, group) => (
    group && group.length > 0 ? [...queue, ...group] : queue
);

/** 当前歌后面还有几首心动歌；不足就补组。当前歌不在队列里时按整条队列算。 */
export const countOwnedAhead = (queue, currentSong) => {
    const currentKey = currentSong ? playbackKey(currentSong) : null;
    const index = currentKey ? queue.findIndex((song) => playbackKey(song) === currentKey) : -1;
    return index < 0 ? queue.length : queue.length - index - 1;
};

/** 队列里还有没有自己加的歌；用户大换队列后据此让会话自己结束。 */
export const hasOwned = (queue, ownedKeys) => queue.some((song) => ownedKeys.has(playbackKey(song)));

/**
 * 退出：回到用户原来的队列，并从「开启时正在放的那首」往后接，
 * 免得退出后又把整张歌单从头放一遍。正在放的心动歌留着，放完再进入原队列。
 */
export const restoreQueue = (currentSong, snapshot, anchorSong) => {
    const list = Array.isArray(snapshot) ? [...snapshot] : [];
    const anchorKey = anchorSong ? playbackKey(anchorSong) : null;
    const anchorIndex = anchorKey ? list.findIndex((song) => playbackKey(song) === anchorKey) : -1;
    const rotated = anchorIndex >= 0
        ? [...list.slice(anchorIndex + 1), ...list.slice(0, anchorIndex + 1)]
        : list;
    const currentKey = currentSong ? playbackKey(currentSong) : null;
    if (currentKey && !rotated.some((song) => playbackKey(song) === currentKey)) {
        return [currentSong, ...rotated];
    }
    return rotated;
};