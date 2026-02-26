import { youtubeService } from './youtubeService.js';

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const overlayUI = {
  createOverlay(album, videoId = null) {
    const overlay = document.createElement('div');
    overlay.className = 'card-overlay';

    // Format link destinations
    let playlistBtnClass = 'action-btn yt-btn';
    let playlistBtnText = '▶ PLAYLIST';
    let playlistBtnHref = '#';
    let playlistTarget = '';

    const hasDiscogsData = album.youtubePlaylistId || (album.youtubeVideoIds && album.youtubeVideoIds.length > 0);

    if (hasDiscogsData || videoId) {
      const isAndroid = navigator.userAgent.includes("Android");
      if (hasDiscogsData) {
        // Prefer Discogs playlist/video list
        if (isAndroid) {
          playlistBtnHref = youtubeService.buildPlaylistIntentUrl(album.youtubePlaylistId, album.youtubeVideoIds);
        } else {
          playlistBtnHref = youtubeService.buildPlaylistWebUrl(album.youtubePlaylistId, album.youtubeVideoIds);
          playlistTarget = '_blank';
        }
      } else {
        // Fallback: open the single resolved video
        playlistBtnHref = `https://www.youtube.com/watch?v=${videoId}`;
        playlistTarget = '_blank';
      }
    } else {
      playlistBtnClass += ' disabled';
      playlistBtnText = 'NO PLAYLIST';
    }

    const categoryName = escHtml(album.category ? album.category.toUpperCase() : 'UNKNOWN');

    overlay.innerHTML = `
      <div class="overlay-top">
        <span class="category-badge">${categoryName}</span>
        <span class="artist-name">${escHtml(album.artist)}</span>
        <span class="album-title">${escHtml(album.title)}</span>
        <span class="album-year">${escHtml(album.year)}</span>
      </div>
      <div class="overlay-bottom">
        <a href="${album.discogsUrl}" target="_blank" class="action-btn">
          🔴 DISCOGS
        </a>
        <a href="${playlistBtnHref}" ${playlistTarget ? `target="${playlistTarget}"` : ''} class="${playlistBtnClass}">
          ${playlistBtnText}
        </a>
      </div>
    `;

    return overlay;
  }
};
