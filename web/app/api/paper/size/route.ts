import { sizePaperPosition, type SizingInput } from '../../../../lib/paper/risk';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const text=await request.text();
    if (text.length>100000) return Response.json({error:'Input too large'},{status:413});
    const input: SizingInput=JSON.parse(text);
    return Response.json(sizePaperPosition(input),{headers:{'Cache-Control':'no-store'}});
  } catch (error) {
    return Response.json({error:error instanceof Error ? error.message : 'Invalid simulation input'},{status:400});
  }
}
