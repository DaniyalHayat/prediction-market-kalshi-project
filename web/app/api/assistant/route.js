import {assistantResponse} from '../../../lib/workspace/assistant.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function POST(request){return assistantResponse(request);}
