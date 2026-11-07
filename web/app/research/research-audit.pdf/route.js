export function GET() {
  return new Response('This research report is no longer publicly available.\n', {
    status: 410,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, noarchive',
    },
  });
}
