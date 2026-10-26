/**
 * The video player. Shows the thumbnail with a play button; nothing loads from Vimeo, YouTube or the file host until the
 * client presses play. Vimeo and YouTube links are embedded; a direct .mp4 (or .webm) plays in a <video>.
 */
import React, { useState } from 'react';
import { brandAsset } from '../../../shared/branding';
import { Icon } from '../../../client/ui';
import { embedUrl, parseVideoUrl } from '../calc';

export function Player({ url, poster, title, onPlay }: { url: string; poster: string; title: string; onPlay: () => void }) {
  const [playing, setPlaying] = useState(false);
  const src = parseVideoUrl(url);
  const img = brandAsset(poster);
  const embed = embedUrl(src);

  if (playing && embed) {
    return (
      <div className="od-player">
        <iframe src={embed} title={title} allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
      </div>
    );
  }
  if (playing && src.kind === 'file') {
    return (
      <div className="od-player">
        <video src={src.url} poster={img} controls autoPlay playsInline preload="metadata" aria-label={title} />
      </div>
    );
  }
  return (
    <div className="od-player">
      {img && <img src={img} alt="" />}
      {src.kind === 'invalid'
        ? <p className="od-bad">This video isn't available right now.</p>
        : <button type="button" className="od-play" aria-label={`Play ${title}`} onClick={() => { setPlaying(true); onPlay(); }}><Icon name="play" size={30} fill /></button>}
    </div>
  );
}
