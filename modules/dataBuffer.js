import { discogsService } from './discogsService.js';
import { youtubeService } from './youtubeService.js';

export const dataBuffer = {
    albumQueue: [],
    readyQueue: [],
    TARGET_ALBUM_QUEUE: 15,
    TARGET_READY_QUEUE: 5, // Increased to 5 for better fluidity since 3 caused stuttering
    isRunning: false,
    criteria: null,

    startPipeline(criteria) {
        this.criteria = criteria;
        this.albumQueue = [];
        this.readyQueue = [];
        this.isRunning = true;

        // Loop 1: Discogs Queue (always keep ~15 albums ready)
        this.runDiscogsLoop();

        // Loop 2: YouTube Queue (always keep ~8 full videos ready)
        this.runYoutubeLoop();
    },

    stopPipeline() {
        this.isRunning = false;
    },

    async runDiscogsLoop() {
        while (this.isRunning) {
            // We must pass fetchDetails = true to obtain the release.videos from Discogs,
            // which saves us from doing a 100-quota-unit YouTube text search for every single card.
            if (this.albumQueue.length < this.TARGET_ALBUM_QUEUE) {
                try {
                    const album = await discogsService.fetchRandomRelease(this.criteria, true);
                    // Only queue albums that have at least one YouTube video or playlist linked on Discogs
                    const hasVideo = album && album.youtubeVideoIds && album.youtubeVideoIds.length > 0;
                    const hasPlaylist = album && album.youtubePlaylistId;
                    if (hasVideo || hasPlaylist) {
                        this.albumQueue.push(album);
                    }
                } catch (err) {
                    if (err.code === 'ZERO_RESULTS') {
                        document.dispatchEvent(new CustomEvent('zeroResults'));
                        this.stopPipeline();
                        return;
                    }
                    console.error("Discogs pipeline error:", err);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } else {
                // Buffer full, rest for a moment
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    },

    async runYoutubeLoop() {
        while (this.isRunning) {
            if (this.readyQueue.length < this.TARGET_READY_QUEUE && this.albumQueue.length > 0) {
                // Take from album queue
                const album = this.albumQueue.shift();

                // Pick a video ID directly from Discogs data — no YouTube API call needed
                let videoId = null;
                if (album.youtubeVideoIds && album.youtubeVideoIds.length > 0) {
                    videoId = album.youtubeVideoIds[Math.floor(Math.random() * album.youtubeVideoIds.length)];
                }
                // playlist-only albums: videoId stays null, player will use playlist mode

                if (videoId || album.youtubePlaylistId) {
                    this.readyQueue.push({ album, videoId });
                }

            } else {
                // Buffer full or no albums ready, rest
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    },

    async consume() {
        if (this.readyQueue.length > 0) {
            return this.readyQueue.shift();
        }

        // Wait until something is ready (polling)
        return new Promise(resolve => {
            const checkInterval = setInterval(() => {
                if (this.readyQueue.length > 0) {
                    clearInterval(checkInterval);
                    resolve(this.readyQueue.shift());
                } else if (!this.isRunning) {
                    clearInterval(checkInterval);
                    resolve(null);
                }
            }, 100);
        });
    }
};
