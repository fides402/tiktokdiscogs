import { CONFIG } from '../config.js';

// The four curated channels to draw videos from
const CHANNEL_HANDLES = [
    'VinyleArcheologie',
    'oleg_samples',
    'librariessountracksandrelated',
    'andrenavarroII',
];

// Per-channel state: { uploadsPlaylistId, videos[], nextPageToken, loading }
const cache = {};
const seenVideos = new Set();

async function ytFetch(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`YouTube API ${res.status}: ${url}`);
    return res.json();
}

// Resolve the "uploads" playlist ID for a channel handle (costs 1 quota unit)
async function resolveUploadsPlaylist(handle) {
    if (cache[handle]?.uploadsPlaylistId) return cache[handle].uploadsPlaylistId;
    const data = await ytFetch(
        `${CONFIG.YOUTUBE_BASE_URL}/channels?part=contentDetails&forHandle=${handle}&key=${CONFIG.YOUTUBE_API_KEY}`
    );
    const uploadsId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsId) throw new Error(`Channel not found: ${handle}`);
    if (!cache[handle]) cache[handle] = { uploadsPlaylistId: null, videos: [], nextPageToken: undefined, loading: false };
    cache[handle].uploadsPlaylistId = uploadsId;
    return uploadsId;
}

// Fetch the next page of videos for a channel (costs 1 quota unit per 50 videos — very cheap)
async function loadMoreVideos(handle) {
    if (!cache[handle]) cache[handle] = { uploadsPlaylistId: null, videos: [], nextPageToken: undefined, loading: false };
    const ch = cache[handle];
    if (ch.loading || ch.nextPageToken === null) return;
    ch.loading = true;
    try {
        const uploadsId = await resolveUploadsPlaylist(handle);
        let url = `${CONFIG.YOUTUBE_BASE_URL}/playlistItems?part=snippet,contentDetails&playlistId=${uploadsId}&maxResults=50&key=${CONFIG.YOUTUBE_API_KEY}`;
        if (ch.nextPageToken) url += `&pageToken=${ch.nextPageToken}`;
        const data = await ytFetch(url);
        const items = (data.items || []).filter(item => {
            const vid = item.contentDetails?.videoId;
            // Skip deleted/private placeholders YouTube sometimes returns
            return vid && vid !== 'deleted video' && item.snippet?.title !== 'Deleted video' && item.snippet?.title !== 'Private video';
        });
        ch.videos.push(...items);
        ch.nextPageToken = data.nextPageToken ?? null;
    } finally {
        cache[handle].loading = false;
    }
}

// Parse "Artist - Title" or "Artist – Title" patterns common in crate-digging channels
function parseTitle(raw) {
    const match = raw.match(/^(.+?)\s[–—-]\s(.+)$/);
    if (match) {
        const artist = match[1].trim();
        // Strip trailing year like (1973) or [1973] from title
        const title = match[2].trim().replace(/\s*[\(\[]\d{4}[\)\]]\s*$/, '').trim();
        return { artist, title };
    }
    return { artist: '', title: raw };
}

export const channelService = {
    // Pre-load the first batch of videos for all channels in parallel.
    // Called once before the pipeline loop starts.
    async init() {
        await Promise.all(CHANNEL_HANDLES.map(h => loadMoreVideos(h).catch(err => {
            console.warn(`channelService: failed to load ${h}:`, err);
        })));
    },

    async fetchRandomVideo() {
        // Uniform random pick across all 4 channels
        const handle = CHANNEL_HANDLES[Math.floor(Math.random() * CHANNEL_HANDLES.length)];
        const ch = cache[handle];

        // Lazy-load if this channel has no videos yet
        if (!ch || ch.videos.length === 0) {
            await loadMoreVideos(handle);
        }

        const pool = cache[handle]?.videos || [];
        if (!pool.length) return null;

        // Prefer videos not yet shown in this session
        const unseen = pool.filter(v => !seenVideos.has(v.contentDetails.videoId));
        const candidates = unseen.length ? unseen : pool;
        const item = candidates[Math.floor(Math.random() * candidates.length)];
        const videoId = item.contentDetails.videoId;

        seenVideos.add(videoId);
        // Prevent unbounded growth
        if (seenVideos.size > 500) seenVideos.delete(seenVideos.values().next().value);

        // Background-fetch more when the unseen pool is getting thin
        if ((pool.length - seenVideos.size) < 20) {
            loadMoreVideos(handle).catch(() => {});
        }

        const snippet = item.snippet || {};
        const { artist, title } = parseTitle(snippet.title || '');

        // Build a Discogs search URL so the user can look up the release
        const q = encodeURIComponent([artist, title].filter(Boolean).join(' '));
        const discogsUrl = `https://www.discogs.com/search/?q=${q}&type=release`;

        return {
            releaseId: videoId,
            title: title || snippet.title || '',
            artist: artist || snippet.channelTitle || handle,
            year: (snippet.publishedAt || '').slice(0, 4),
            // category badge shows the channel name
            category: snippet.channelTitle || handle,
            coverUrl: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || '',
            discogsUrl,
            youtubeVideoIds: [videoId],
            youtubePlaylistId: null,
            trackList: [],
            // Tells overlayUI to render the "VIDEO" button instead of "PLAYLIST"
            isChannelMode: true,
        };
    },

    clearSession() {
        seenVideos.clear();
    },
};
