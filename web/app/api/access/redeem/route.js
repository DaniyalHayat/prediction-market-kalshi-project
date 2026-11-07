import {redeemShareAccess} from '../../../../lib/private-access.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request){return redeemShareAccess(request);}
