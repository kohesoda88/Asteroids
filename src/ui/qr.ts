import qrcode from 'qrcode-generator';

/** 文字列を QR コードの SVG 文字列にする（大きさは CSS で指定） */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'L');
  qr.addData(text, 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

/** 参加用 URL（ハッシュに招待コードを入れる。ハッシュはサーバーに送られない） */
export function joinUrl(offerCode: string): string {
  return `${location.origin}${location.pathname}#j=${offerCode}`;
}

/** 起動時の URL から招待コードを取り出し、URL からは消す */
export function takeJoinCodeFromUrl(): string | null {
  const m = location.hash.match(/^#j=(.+)$/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return decodeURIComponent(m[1]);
}

export function canScan(): boolean {
  return typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/** カメラで QR コードを読み取る。読み取れた文字列か、キャンセル時は null を返す */
export async function scanQr(overlay: HTMLElement): Promise<string | null> {
  const video = overlay.querySelector('video')!;
  const msg = overlay.querySelector<HTMLElement>('.scan-msg')!;
  const close = overlay.querySelector<HTMLButtonElement>('.scan-close')!;
  overlay.classList.remove('hidden');
  msg.textContent = 'カメラを起動しています…';

  let stream: MediaStream | null = null;
  let done = false;
  const stop = () => {
    done = true;
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    overlay.classList.add('hidden');
  };

  return new Promise<string | null>((resolve) => {
    close.onclick = () => {
      stop();
      resolve(null);
    };
    (async () => {
      try {
        const { default: jsQR } = await import('jsqr');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (done) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();
        msg.textContent = '相手の画面の QR コードを枠内に映してください';
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        const tick = () => {
          if (done) return;
          if (video.readyState >= 2 && video.videoWidth > 0) {
            // 処理を軽くするため長辺 640px に縮小して解析
            const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (code?.data) {
              stop();
              resolve(code.data);
              return;
            }
          }
          requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        msg.textContent = `カメラを使えませんでした（${(e as Error).name}）。コードのコピー＆貼り付けを使ってください。`;
      }
    })();
  });
}
