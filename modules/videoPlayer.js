export const videoPlayer = {
    async createPlayer(cardElement, videoId, playlistId = null) {
        if (!videoId && !playlistId) return null;

        // Ensure YT API is ready
        if (typeof window.YT === 'undefined' || typeof window.YT.Player === 'undefined') {
            console.warn("YouTube API not ready yet");
            return null;
        }

        // Container inside card
        const container = cardElement.querySelector('.yt-player-container');
        if (!container) return null;

        // Unique ID for the player div
        const playerId = `yt-player-${videoId || playlistId}-${Date.now()}`;
        const playerDiv = document.createElement('div');
        playerDiv.id = playerId;
        container.appendChild(playerDiv);

        await window.ytApiReady;

        const playerVars = {
            autoplay: 0,
            controls: 0,
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
            iv_load_policy: 3,
            mute: 1
        };

        // If no individual video ID, play the Discogs playlist instead
        if (!videoId && playlistId) {
            playerVars.list = playlistId;
            playerVars.listType = 'playlist';
        }

        return new window.YT.Player(playerId, {
            videoId: videoId || undefined,
            playerVars,
            events: {
                onStateChange: (event) => {
                    if (event.data === window.YT.PlayerState.ENDED) {
                        const endedEvent = new CustomEvent('videoEnded');
                        document.dispatchEvent(endedEvent);
                    }
                }
            }
        });
    },

    play(playerInstance) {
        if (!playerInstance) return;

        // If readyState is correct, play
        if (typeof playerInstance.playVideo === 'function') {
            playerInstance.playVideo();
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
