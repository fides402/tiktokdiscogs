import { CONFIG } from '../config.js';

export const youtubeService = {
    async searchVideo(artist, albumTitle, existingVideoIds = []) {
        // 1. If we already have a video ID from Discogs, just use a random one
        if (existingVideoIds && existingVideoIds.length > 0) {
            return existingVideoIds[Math.floor(Math.random() * existingVideoIds.length)];
        }

        // 2. Build query string
        const query = `${artist} ${albumTitle} full album`;

        // 3. Setup GET params
        const params = new URLSearchParams({
            part: 'snippet',
            q: query,
            type: 'video',
            maxResults: 5,
            key: CONFIG.YOUTUBE_API_KEY
        });

        const searchUrl = `${CONFIG.YOUTUBE_BASE_URL}/search?${params.toString()}`;

        try {
            let response = await fetch(searchUrl);

            if (!response.ok) {
                throw new Error(`YouTube API Error: ${response.status}`);
            }

            let data = await response.json();

            // 4. Return first result
            if (data.items && data.items.length > 0) {
                return data.items[0].id.videoId;
            }

            // Fallback: try more generic query
            const genericQuery = `${artist} ${albumTitle}`;
            params.set('q', genericQuery);

            response = await fetch(`${CONFIG.YOUTUBE_BASE_URL}/search?${params.toString()}`);
            data = await response.json();

            if (data.items && data.items.length > 0) {
                return data.items[0].id.videoId;
            }

            throw new Error("No YouTube video found");

        } catch (error) {
            console.error("YouTube search error:", error);
            throw error;
        }
    },

    async searchPlaylist(artist, albumTitle) {
        const query = `${artist} ${albumTitle} full album`;
        const params = new URLSearchParams({
            part: 'snippet',
            q: query,
            type: 'playlist',
            maxResults: 1,
            key: CONFIG.YOUTUBE_API_KEY
        });

        const searchUrl = `${CONFIG.YOUTUBE_BASE_URL}/search?${params.toString()}`;

        try {
            const response = await fetch(searchUrl);
            if (!response.ok) {
                throw new Error(`YouTube API Error: ${response.status}`);
            }

            const data = await response.json();

            if (data.items && data.items.length > 0) {
                return data.items[0].id.playlistId;
            }

            return null;

        } catch (error) {
            console.error("YouTube playlist search error:", error);
            return null;
        }
    },

    buildPlaylistIntentUrl(playlistId, videoIds = []) {
        if (playlistId) {
            return `intent://www.youtube.com/playlist?list=${playlistId}#Intent;scheme=http;action=android.intent.action.VIEW;end`;
        } else if (videoIds && videoIds.length > 0) {
            const idsStr = videoIds.join(',');
            return `intent://www.youtube.com/watch_videos?video_ids=${idsStr}#Intent;scheme=http;action=android.intent.action.VIEW;end`;
        }
        return null;
    },

    buildPlaylistWebUrl(playlistId, videoIds = []) {
        if (playlistId) {
            return `https://www.youtube.com/playlist?list=${playlistId}`;
        } else if (videoIds && videoIds.length > 0) {
            const idsStr = videoIds.join(',');
            return `https://www.youtube.com/watch_videos?video_ids=${idsStr}`;
        }
        return null;
    }
};
