'use client';
import {useEffect,useRef} from 'react';
import type UPlot from 'uplot';
type Point={date?:string;time?:string;value?:number|null};
type Props={rows?:Point[];height?:number;unit?:'price'|'usd'|'count';label?:string;error?:string;theme?:string};
const timeOf=(row:Point)=>Date.parse(row.date||row.time||'');
export default function Chart({rows=[],height=210,unit='price',label='Observed price history',error,theme='graphite'}:Props) {
  const host=useRef<HTMLDivElement|null>(null);
  const points=rows.flatMap(row=>typeof row.value==='number'&&Number.isFinite(row.value)&&Number.isFinite(timeOf(row))?
    [[timeOf(row)/1000,row.value] as const]:[]);
  useEffect(()=>{
    let plot:UPlot|undefined,observer:ResizeObserver|undefined,disposed=false;
    const unique=[...new Map(points.map(row=>[row[0],row])).values()].sort((a,b)=>a[0]-b[0]);
    if(unique.length<2)return;
    import('uplot').then(({default:UPlot})=>{
      if(disposed||!host.current)return;
      const colors=getComputedStyle(host.current),stroke=colors.getPropertyValue('--accent').trim()||'#ededed',muted=colors.getPropertyValue('--muted').trim()||'#a1a1a1',line=colors.getPropertyValue('--line').trim()||'#262626';
      const format=(value:number)=>unit==='price'?`${(value*100).toFixed(0)}¢`:unit==='usd'?value.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:1}):value.toLocaleString(undefined,{maximumFractionDigits:1});
      plot=new UPlot({width:host.current.clientWidth,height,legend:{show:false},cursor:{drag:{x:false,y:false}},
        scales:{x:{time:true},y:{auto:true}},series:[{}, {stroke,width:2,fill:stroke+'10',value:(_,v)=>v===null?'—':format(v)}],
        axes:[{stroke:muted,grid:{show:false},font:'12px system-ui'},{size:58,stroke:muted,grid:{stroke:line,width:1},font:'12px system-ui',values:(_,values)=>values.map(format)}]},
      [unique.map(row=>row[0]),unique.map(row=>row[1])],host.current);
      observer=new ResizeObserver(()=>{if(host.current)plot?.setSize({width:host.current.clientWidth,height});});observer.observe(host.current);
    });
    return()=>{disposed=true;observer?.disconnect();plot?.destroy();};
  },[rows,height,unit,theme]);
  const present=new Set(points.map(([time])=>time)).size>=2;
  return <div className="chart" role="img" aria-label={label+(error?': source unavailable':'')} ref={host}>{!present&&<div className="chart-empty">{error?'Price history is unavailable: '+error:'No comparable history has been returned for this contract yet.'}</div>}</div>;
}
