import { discogsService } from './discogsService.js';
import { channelService } from './channelService.js';

export const dataBuffer = {
    albumQueue: [],
    readyQueue: [],
    TARGET_ALBUM_QUEUE: 15,
    TARGET_READY_QUEUE: 5,
    isRunning: false,
    criteria: null,
    _generation: 0,

    startPipeline(criteria) {
        // Increment generation to invalidate any loops from a previous pipeline
        this._generation++;
        const gen = this._generation;

        // Reset Discogs caches so every new exploration starts with fresh, unpredictable results
        discogsService.clearSession();

        this.criteria = criteria;
        this.albumQueue = [];
        this.readyQueue = [];
        this.isRunning = true;

        // Loop 1: Discogs Queue (always keep ~15 albums ready)
        this.runDiscogsLoop(gen);

        // Loop 2: YouTube Queue (always keep ~5 full items ready)
        this.runYoutubeLoop(gen);
    },

    startChannelPipeline() {
        this._generation++;
        const gen = this._generation;

        channelService.clearSession();

        this.albumQueue = [];
        this.readyQueue = [];
        this.isRunning = true;

        this.runChannelsLoop(gen);
    },

    async runChannelsLoop(gen) {
        await channelService.init();
        if (this._generation !== gen) return;

        // If every channel failed to load (bad API key, quota exhausted, etc.) tell the user
        if (!channelService.hasAnyVideos()) {
            document.dispatchEvent(new CustomEvent('channelLoadError'));
            this.stopPipeline();
            return;
        }

        let consecutiveNulls = 0;

        while (this.isRunning && this._generation === gen) {
            if (this.readyQueue.length < this.TARGET_READY_QUEUE) {
                try {
                    const album = await channelService.fetchRandomVideo();
                    if (!album) {
                        consecutiveNulls++;
                        // After 10 consecutive nulls all channels are dry → surface error
                        if (consecutiveNulls >= 10) {
                            document.dispatchEvent(new CustomEvent('channelLoadError'));
                            this.stopPipeline();
                            return;
                        }
                        await new Promise(r => setTimeout(r, 500));
                        continue;
                    }
                    consecutiveNulls = 0;
                    if (this._generation === gen) {
                        this.readyQueue.push({ album, videoId: album.youtubeVideoIds[0] });
                    }
                } catch (err) {
                    console.error('Channel pipeline error:', err);
                    await new Promise(r => setTimeout(r, 2000));
                }
            } else {
                await new Promise(r => setTimeout(r, 200));
            }
        }
    },

    stopPipeline() {
        this.isRunning = false;
        this._generation++; // Invalidate running loops immediately
    },

    async runDiscogsLoop(gen) {
        while (this.isRunning && this._generation === gen) {
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

    async runYoutubeLoop(gen) {
        while (this.isRunning && this._generation === gen) {
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
