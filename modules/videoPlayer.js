export const videoPlayer = {
    async createPlayer(cardElement, videoId, playlistId = null, onEnded = null) {
        if (!videoId && !playlistId) return null;

        // Wait for the YouTube IFrame API to finish loading before proceeding.
        // This is the single place where we block on ytApiReady, so app.js
        // init() can show the category screen immediately without waiting.
        await window.ytApiReady;

        if (typeof window.YT === 'undefined' || typeof window.YT.Player === 'undefined') {
            console.warn("YouTube API failed to load");
            return null;
        }

        // Container inside card
        const container = cardElement.querySelector('.yt-player-container');
        if (!container) return null;

        let primaryVideoId = videoId;
        const playerVars = {
            autoplay: 1,
            controls: 0,
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
            iv_load_policy: 3,
            mute: 1
        };

        // Handle arrays of video IDs (from Discogs videos)
        if (Array.isArray(videoId)) {
            if (videoId.length > 0) {
                primaryVideoId = videoId[0];
                if (videoId.length > 1) {
                    playerVars.playlist = videoId.slice(1).join(',');
                }
            } else {
                return null;
            }
        } else if (typeof videoId === 'string' && (videoId.startsWith('PL') || videoId.startsWith('OL'))) {
            // Handle actual YouTube Playlist IDs
            primaryVideoId = '';
            playerVars.listType = 'playlist';
            playerVars.list = videoId;
        } else if (!videoId && playlistId) {
            // If no individual video ID, play the Discogs playlist instead
            primaryVideoId = undefined;
            playerVars.list = playlistId;
            playerVars.listType = 'playlist';
        }

        // Use safe ID
        const safePlayerId = `yt-player-${typeof primaryVideoId === 'string' && primaryVideoId ? primaryVideoId : (playlistId || 'list')}-${Date.now()}`;
        const playerDiv = document.createElement('div');
        playerDiv.id = safePlayerId;
        container.appendChild(playerDiv);

        return new Promise((resolve) => {
            let player;
            // Safety net: if onReady never fires (e.g. network stall), unblock after 8s
            const timeoutId = setTimeout(() => {
                console.warn(`YT onReady timeout for ${primaryVideoId || playlistId}`);
                resolve(player || null);
            }, 8000);

            player = new window.YT.Player(safePlayerId, {
                videoId: primaryVideoId,
                playerVars,
                events: {
                    onReady: (event) => {
                        clearTimeout(timeoutId);
                        resolve(event.target);
                    },
                    onStateChange: (event) => {
                        if (event.data === window.YT.PlayerState.ENDED) {
                            // For playlists: only trigger end when the last video finishes
                            let isPlaylistFinished = true;
                            if (typeof player.getPlaylist === 'function' && typeof player.getPlaylistIndex === 'function') {
                                const playlist = player.getPlaylist();
                                if (playlist && playlist.length > 0) {
                                    const currentVidIndex = player.getPlaylistIndex();
                                    if (currentVidIndex < playlist.length - 1) {
                                        isPlaylistFinished = false;
                                    }
                                }
                            }
                            if (isPlaylistFinished && onEnded) {
                                onEnded();
                            }
                        }
                    }
                }
            });
        });
    },

    play(playerInstance) {
        if (!playerInstance) return;

        // If readyState is correct, play
        if (typeof playerInstance.playVideo === 'function') {
            playerInstance.playVideo();
            // Fallback for YouTube IFrame bug where playVideo is ignored right after onReady.
            // Only retry if stuck in UNSTARTED (-1) or BUFFERING (3).
            // Do NOT retry PAUSED (2): that state means the card was intentionally paused
            // (e.g. user scrolled away), and re-starting it would cause audio to overlap.
            setTimeout(() => {
                if (typeof playerInstance.getPlayerState === 'function') {
                    const state = playerInstance.getPlayerState();
                    if (state === -1 || state === 3) {
                        playerInstance.playVideo();
                    }
                }
            }, 300);
        } else if (playerInstance.addEventListener) {
            // Queue it up if not ready
            playerInstance.addEventListener('onReady', () => {
                playerInstance.playVideo();
            });
        }
    },

    pause(playerInstance) {
        if (!playerInstance) return;
        if (typeof playerInstance.pauseVideo === 'function') {
            playerInstance.pauseVideo();
        }
    },

    destroyPlayer(playerInstance) {
        if (!playerInstance) return;
        if (typeof playerInstance.destroy === 'function') {
            playerInstance.destroy();
        }
    }
};
