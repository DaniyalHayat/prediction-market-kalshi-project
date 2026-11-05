'use client';
import {useEffect,useRef} from 'react';
export default function Chart({rows=[],height=210,unit='price',label='Observed price history',error,theme='graphite'}) {
  const host=useRef(null);
  useEffect(()=>{
    let plot,observer,disposed=false;
    const points=rows.filter(row=>typeof row.value==='number'&&Number.isFinite(row.value)&&Number.isFinite(Date.parse(row.date||row.time)))
      .map(row=>[Date.parse(row.date||row.time)/1000,Number(row.value)]).sort((a,b)=>a[0]-b[0]);
    const unique=[...new Map(points.map(row=>[row[0],row])).values()];
    if(unique.length<2)return;
    import('uplot').then(({default:UPlot})=>{
      if(disposed||!host.current)return;
      const colors=getComputedStyle(host.current),stroke=colors.getPropertyValue('--accent').trim()||'#8db8ff',muted=colors.getPropertyValue('--muted').trim()||'#a9b6c8',line=colors.getPropertyValue('--line').trim()||'#2b3647';
      const format=value=>unit==='price'?`${(value*100).toFixed(0)}¢`:unit==='usd'?value.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:1}):value.toLocaleString(undefined,{maximumFractionDigits:1});
      plot=new UPlot({width:host.current.clientWidth,height,legend:{show:false},cursor:{drag:{x:false,y:false}},
        scales:{x:{time:true},y:{auto:true}},series:[{}, {stroke,width:2,fill:stroke+'10',value:(_,v)=>v===null?'—':format(v)}],
        axes:[{stroke:muted,grid:{show:false},font:'12px system-ui'},{size:58,stroke:muted,grid:{stroke:line,width:1},font:'12px system-ui',values:(_,values)=>values.map(format)}]},
      [unique.map(row=>row[0]),unique.map(row=>row[1])],host.current);
      observer=new ResizeObserver(()=>{if(host.current)plot?.setSize({width:host.current.clientWidth,height});});observer.observe(host.current);
    });
    return()=>{disposed=true;observer?.disconnect();plot?.destroy();};
  },[rows,height,unit,theme]);
  const present=new Set(rows.filter(row=>typeof row.value==='number'&&Number.isFinite(row.value)&&Number.isFinite(Date.parse(row.date||row.time))).map(row=>Date.parse(row.date||row.time))).size>=2;
  return <div className="chart" role="img" aria-label={label+(error?': source unavailable':'')} ref={host}>{!present&&<div className="chart-empty">{error?'Price history is unavailable: '+error:'No comparable history has been returned for this contract yet.'}</div>}</div>;
}
