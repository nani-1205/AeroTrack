/** Top-down aircraft silhouette pointing north, drawn on a canvas (no image assets needed). */
export function planeIcon(fill: string, size = 64): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.translate(size / 2, size / 2);
  g.scale(size / 64, size / 64);

  g.beginPath();
  g.moveTo(0, -28);
  g.bezierCurveTo(3, -26, 4, -20, 4, -14);
  g.lineTo(4, -6);
  g.lineTo(27, 6);
  g.lineTo(27, 11);
  g.lineTo(4, 5);
  g.lineTo(3, 18);
  g.lineTo(10, 23);
  g.lineTo(10, 27);
  g.lineTo(0, 24);
  g.lineTo(-10, 27);
  g.lineTo(-10, 23);
  g.lineTo(-3, 18);
  g.lineTo(-4, 5);
  g.lineTo(-27, 11);
  g.lineTo(-27, 6);
  g.lineTo(-4, -6);
  g.lineTo(-4, -14);
  g.bezierCurveTo(-4, -20, -3, -26, 0, -28);
  g.closePath();

  g.lineJoin = 'round';
  g.lineWidth = 3;
  g.strokeStyle = '#ffffff'; // white outline keeps the icon readable over any basemap
  g.stroke();
  g.fillStyle = fill;
  g.fill();
  return g.getImageData(0, 0, size, size);
}
