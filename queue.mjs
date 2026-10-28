// queue.mjs — 纯函数：播放队列的拼接、计数与还原。
//
// 这里的「歌」是宿主给的 FoliumSong DTO：`source` + `id` 是它在音源里的可移植身份，`ref` 只在本次
// 会话有效。队列项是 `folium.playback.getQueue()` 的 `{ song, index }`。
//
// 宿主按「歌在队列里的第一次出现」认当前歌（`FoliumQueueSnapshot.currentIndex`），所以同一个身份在
// 队列里出现两次会让定位和下一首一起出错。这个文件里所有拼队列的地方都靠 `songKey` 去重。

/** 一首歌在音源里的可移植身份。 */
export const songKey = (song) => `${song?.source ?? ''}\u0000${song?.id ?? ''}`;

/** 队列项里的歌（`getQueue` 给 `{song,index}`；测试里也接受裸歌）。 */
const songOf = (item) => (item && typeof item === 'object' && 'song' in item ? item.song : item);

/** 队列项的 key。 */
export const itemKey = (item) => songKey(songOf(item));

/** 按顺序去重，并排除 `excluded`（一个 key 的 Set）。认不出身份的歌直接丢掉：它进队列后既没法去重，也没法在退出时被认出来。 */
export const uniqueSongs = (songs, excluded = new Set()) => {
    const seen = new Set(excluded);
    const out = [];
    for (const song of songs) {
        if (!song || !song.source || !song.id) continue;
        const key = songKey(song);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(song);
    }
    return out;
};

/** 当前歌在队列里的位置；-1 表示不在队列里。 */
export const indexOfCurrent = (items, currentSong) => {
    if (!currentSong || !currentSong.source || !currentSong.id) return -1;
    const key = songKey(currentSong);
    return items.findIndex((item) => itemKey(item) === key);
};

/** 当前歌后面还有几首。当前歌不在队列里时，整个队列都算「后面」。 */
export const countAhead = (items, currentIndex) => (
    currentIndex < 0 ? items.length : Math.max(0, items.length - currentIndex - 1)
);

/**
 * 把一段队列按 `anchorSong` 旋成「anchor 打头」：anchor 之后的部分先来，再从头补到 anchor 之前。
 * 退出心动模式时用它把用户原来的队列接回当前这首。队列本来就循环播放，所以绕回来是对的：不重复、
 * 也不丢歌。
 */
export const rotateFrom = (items, anchorSong) => {
    const songs = items.map(songOf);
    if (songs.length === 0) return [];
    const at = anchorSong ? songs.findIndex((song) => songKey(song) === songKey(anchorSong)) : -1;
    if (at < 0) return songs;
    return [...songs.slice(at), ...songs.slice(0, at)];
};

/** 当前歌 + 原队列里 anchor 之后的部分：退出时交给 `replaceQueue` 的队列。 */
export const queueFromOriginal = (originalSongs, anchorSong, currentSong) => {
    const ordered = rotateFrom(originalSongs, anchorSong);
    const current = currentSong ?? null;
    const rest = ordered.filter((song) => !current || songKey(song) !== songKey(current));
    return uniqueSongs([...(current ? [current] : []), ...rest]);
};