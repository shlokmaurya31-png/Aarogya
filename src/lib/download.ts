export function downloadTextFile(filename: string, contents: string) {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function openDirections(facility: string) {
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(facility)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}
