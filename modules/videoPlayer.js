export const videoPlayer = {
    async createPlayer(cardElement, videoId) {
        if (!videoId) return null;

        // Ensure YT API is ready
        if (typeof window.YT === 'undefined' || typeof window.YT.Player === 'undefined') {
            console.warn("YouTube API not ready yet");
            return null;
        }

        // Container inside card
        const container = cardElement.querySelector('.yt-player-container');
        if (!container) return null;

        // Unique ID for the player div
        await window.ytApiReady;

        let primaryVideoId = videoId;
        const playerVars = {
            autoplay: 0,
            controls: 0,
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
            iv_load_policy: 3,
            mute: 1 // Start muted for autoplay policies, will add unmute logic in feedManager/app
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
        }

        const safePlayerId = `yt-player-${typeof primaryVideoId === 'string' && primaryVideoId ? primaryVideoId : 'list'}-${Date.now()}`;

        const playerDiv = document.createElement('div');
        playerDiv.id = safePlayerId;
        container.appendChild(playerDiv);

        return new Promise((resolve) => {
            const player = new window.YT.Player(safePlayerId, {
                videoId: primaryVideoId,
                playerVars: playerVars,
                events: {
                    onReady: () => {
                        resolve(player);
                    },
                    onStateChange: (event) => {
                        if (event.data === window.YT.PlayerState.ENDED) {
                            // Check if this is a playlist and there are more videos
                            let isPlaylistFinished = true;
                            if (typeof player.getPlaylist === 'function' && typeof player.getPlaylistIndex === 'function') {
                                const playlist = player.getPlaylist();
                                if (playlist && playlist.length > 0) {
                                    const currentVidIndex = player.getPlaylistIndex();
                                    // If we are not at the last video, don't trigger end
                                    if (currentVidIndex < playlist.length - 1) {
                                        isPlaylistFinished = false;
                                    }
                                }
                            }

                            if (isPlaylistFinished) {
                                const endedEvent = new CustomEvent('videoEnded');
                                document.dispatchEvent(endedEvent);
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
            // Fallback for YouTube IFrame bug where playVideo is ignored right after onReady
            setTimeout(() => {
                if (typeof playerInstance.getPlayerState === 'function' && playerInstance.getPlayerState() !== window.YT.PlayerState.PLAYING) {
                    playerInstance.playVideo();
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
