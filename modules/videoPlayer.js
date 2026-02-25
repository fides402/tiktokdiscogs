export const videoPlayer = {
    createPlayer(cardElement, videoId) {
        // Ensure YT API is ready
        if (typeof window.YT === 'undefined' || typeof window.YT.Player === 'undefined') {
            console.warn("YouTube API not ready yet");
            return null;
        }

        // Container inside card
        const container = cardElement.querySelector('.yt-player-container');
        if (!container) return null;

        // Unique ID for the player div
        const playerId = `yt-player-${videoId}-${Date.now()}`;
        const playerDiv = document.createElement('div');
        playerDiv.id = playerId;
        container.appendChild(playerDiv);

        return new window.YT.Player(playerId, {
            videoId: videoId,
            playerVars: {
                autoplay: 0,
                controls: 0,
                modestbranding: 1,
                playsinline: 1,
                rel: 0,
                iv_load_policy: 3,
                mute: 1 // Start muted for autoplay policies, will add unmute logic in feedManager/app
            },
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
