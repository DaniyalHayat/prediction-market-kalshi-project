import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';

const pageWidth=612,pageHeight=792,margin=50,bodyWidth=pageWidth-2*margin;
const ink=rgb(.08,.15,.17),muted=rgb(.29,.38,.4),accent=rgb(.06,.34,.29),line=rgb(.82,.87,.86),shade=rgb(.95,.97,.96);
const text=value=>String(value??'').normalize('NFKD').replace(/\p{Mark}/gu,'').replace(/[–—]/g,'-').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[^\x20-\x7e]/g,' ').replace(/\s+/g,' ').trim();
const number=(n,digits=3)=>Number.isFinite(n)?n.toLocaleString('en-US',{maximumFractionDigits:digits}):'Unavailable';
const dollars=n=>Number.isFinite(n)?n.toLocaleString('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:3}):'Unavailable';
const percent=n=>Number.isFinite(n)?(100*n).toFixed(1)+'%':'Unavailable';
const price=n=>Number.isFinite(n)?number(n*100,2)+' cents':'Unavailable';
const stamp=value=>Number.isFinite(Date.parse(value))?new Date(value).toISOString().replace('T',' ').replace(/\.\d+Z$/,' UTC'):'Unavailable';

function wrap(value,font,size,width){
  const lines=[];let line='';
  for(let word of text(value).split(' ')){
    const joined=line?line+' '+word:word;
    if(font.widthOfTextAtSize(joined,size)<=width){line=joined;continue;}
    if(line)lines.push(line);
    while(font.widthOfTextAtSize(word,size)>width){
      let end=1;
      while(end<word.length&&font.widthOfTextAtSize(word.slice(0,end+1),size)<=width)end++;
      lines.push(word.slice(0,end));word=word.slice(end);
    }
    line=word;
  }
  if(line)lines.push(line);
  return lines;
}

export async function buildExecutionPDF(value){
  if(!/^[A-Za-z0-9_.:-]{1,180}$/.test(value?.ticker||'')||!value.controls||!value.schedule)throw new RangeError('A submitted execution scenario is required');
  const document=await PDFDocument.create(),regular=await document.embedFont(StandardFonts.Helvetica),bold=await document.embedFont(StandardFonts.HelveticaBold);
  document.setTitle('Predictir | Execution research | '+value.ticker);
  document.setSubject('Hypothetical execution research from a public order-book snapshot');
  let page,y;
  function draw(value,x,y,size=10,font=regular,color=ink){page.drawText(text(value),{x,y,size,font,color});}
  function rule(y){page.drawLine({start:{x:margin,y},end:{x:pageWidth-margin,y},color:line,thickness:.7});}
  function newPage(){
    page=document.addPage([pageWidth,pageHeight]);y=715;
    draw('Predictir',margin,750,10,bold,accent);
    draw('PAPER RESEARCH',462,750,10,bold,accent);
    rule(738);
  }
  function reserve(height){if(y-height<62)newPage();}
  function paragraph(value,{size=10,font=regular,color=ink,leading=15}={}){
    for(const row of wrap(value,font,size,bodyWidth)){reserve(leading);draw(row,margin,y,size,font,color);y-=leading;}
  }
  function heading(value){reserve(45);y-=14;paragraph(value,{size:14,font:bold,leading:22});}
  function metric(label,value){
    reserve(18);draw(label,margin,y,10,regular,muted);draw(value,322,y,10,bold);y-=16;
  }
  const c=value.controls,s=value.schedule,base=s.benchmark_twap||{},fill=value.immediate_execution||{},forecast=value.forecast||{},book=value.market_state||{};
  const action=c.action==='sell'?'Sell':'Buy',side=String(c.side||'yes').toUpperCase();
  newPage();
  paragraph('Execution scenario',{size:26,font:bold,leading:34});
  paragraph(value.title||value.ticker,{size:14,font:bold,leading:20});
  paragraph(value.ticker+'  |  '+stamp(value.as_of),{size:10,color:muted});
  y-=8;
  paragraph(`${action} ${side}, ${number(c.contracts)} contracts over ${number(c.horizon_seconds)} seconds.`,{size:12,font:bold,leading:19});
  paragraph('Public market depth and conditional model estimates. No orders were submitted and no account information was used.',{color:muted});
  heading('Observed book and estimated fill');
  metric('Book observed',stamp(value.book_as_of||value.as_of));
  metric(side+' bid / ask',price(book.bid)+' / '+price(book.ask));
  metric('Estimated fill / requested',number(fill.filled)+' / '+number(fill.requested));
  metric('Unfilled / average fill price',number(fill.unfilled)+' / '+price(fill.vwap));
  metric(action==='Buy'?'Cash required / modeled fee':'Net proceeds / modeled fee',dollars(fill.cash)+' / '+dollars(fill.fee));
  if(value.fee_schedule?.note)paragraph(value.fee_schedule.note,{color:muted});
  heading('Timing comparison');
  metric('Selected schedule cost / risk objective',dollars(s.expected_cost)+' / '+dollars(s.objective));
  metric('Even-paced cost / risk objective',dollars(base.expected_cost)+' / '+dollars(base.objective));
  metric('Selected / even-paced variance (USD squared)',number(s.risk_variance,6)+' / '+number(base.risk_variance,6));
  paragraph('These figures compare the same horizon and assumptions. A lower risk objective is a conditional model result.',{color:muted});
  heading('Independent forecast');
  metric(forecast.outcomes?'YES team win chance':'Independent P(YES)',percent(forecast.probability));
  if(Array.isArray(forecast.interval)&&forecast.interval.length===2)metric('Model probability range',forecast.interval.map(percent).join(' to '));
  if(forecast.outcomes){
    metric('Opposing team win / tie chance',percent(forecast.outcomes.loss)+' / '+percent(forecast.outcomes.tie));
    metric('Modeled YES settlement per contract',dollars(forecast.expected_settlement_value));
    paragraph('A tie pays $0.50 per contract.',{color:muted});
  }
  if(forecast.experimental)paragraph('Experimental outcome estimate. The release checks have not passed.',{color:muted});
  if(!Number.isFinite(forecast.probability))paragraph('The execution comparison can use quotes without a supported independent forecast.',{color:muted});
  heading('Scenario inputs');
  metric('Volatility / temporary impact',number(c.volatility,8)+' / '+number(c.temporary_impact,8));
  metric('Risk aversion / starting inventory',number(c.risk_aversion,8)+' / '+number(c.inventory));
  paragraph('Volatility is in USD per contract per square root minute. Temporary impact is in USD times minute per contract squared. Risk aversion is in inverse USD.',{color:muted});
  const features=[['Order flow',c.order_flow],['Arrival clustering',c.arrival_clustering],['Inventory skew',c.inventory_skew],['Risk-aware timing',c.optimal_schedule]];
  paragraph('Model components: '+features.map(([label,enabled])=>label+' '+(c.enabled&&enabled?'on':'off')).join(', ')+'.',{color:muted});

  newPage();
  heading('Execution schedule');
  paragraph('Each quantity is a modeled target. A slice can be fractional and has no confirmed fill.',{color:muted});
  y-=7;
  function tableHeader(){
    page.drawRectangle({x:margin,y:y-7,width:bodyWidth,height:23,color:shade});
    draw('Elapsed seconds',margin+10,y,10,bold);
    draw('Planned contracts',margin+181,y,10,bold);
    draw('Remaining contracts',margin+358,y,10,bold);
    y-=26;
  }
  tableHeader();
  for(const row of (s.rows||[]).slice(0,60)){
    if(y<80){newPage();heading('Execution schedule continued');tableHeader();}
    draw(number(row.time_seconds,1),margin+10,y);
    draw(number(row.contracts),margin+181,y);
    draw(number(row.remaining),margin+358,y);
    rule(y-5);y-=15;
  }
  heading('Coverage and assumptions');
  paragraph(`${number(value.data_quality?.contiguous_events)} retained book events; ${number(value.data_quality?.quote_event_span_seconds,1)} seconds observed.`,{color:muted});
  for(const gap of (value.data_quality?.gaps||[]).slice(0,4))paragraph(typeof gap==='string'?gap:gap?.reason||gap?.detail,{color:muted});
  for(const item of (value.limitations||[]).slice(0,6))paragraph(typeof item==='string'?item:item?.detail,{color:muted});
  if(value.sources?.length){
    heading('Public source records');
    for(const source of value.sources.slice(0,4)){
      try{
        const url=new URL(source.url);
        if(url.protocol!=='https:'||url.username||url.password)continue;
        paragraph((source.label||'Source')+' | '+stamp(source.as_of||source.retrieved_at),{font:bold});
        paragraph(url.href,{size:9,color:muted,leading:13});
      }catch{}
    }
  }
  const pages=document.getPages();
  for(const [index,item] of pages.entries()){
    page=item;rule(48);draw(value.ticker,margin,32,8,regular,muted);
    draw(`${index+1} / ${pages.length}`,529,32,8,regular,muted);
  }
  return document.save();
}

export async function downloadExecutionPDF(value){
  const bytes=await buildExecutionPDF(value);
  const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})),anchor=window.document.createElement('a');
  anchor.href=url;anchor.download=value.ticker.replace(/[^A-Za-z0-9_.-]/g,'-')+'-execution-research.pdf';
  anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
