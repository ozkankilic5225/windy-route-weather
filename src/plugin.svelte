<script>
 import { onMount, onDestroy } from 'svelte';
 import { map } from '@windy/map';
 import bcast from '@windy/broadcast';
 import store from '@windy/store';
 import { singleclick } from '@windy/singleclick';
 import config from './pluginConfig';
 export let pluginRootElement;
// Screen-space projection keeps the hit tolerance constant at every zoom level.
function nearestOnSegments(p, points) {
 let best = null;
 for (let i = 1; i < points.length; i++) {
  const a = points[i-1], b = points[i];
  const dx=b.x-a.x, dy=b.y-a.y, d=dx*dx+dy*dy;
  const t=d ? Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/d)) : 0;
  const x=a.x+t*dx,y=a.y+t*dy, distance=Math.hypot(p.x-x,p.y-y);
  if (!best || distance<best.distance) best={x,y,distance,segment:i-1,t};
 }
 return best;
}

 let points=[], drawing=true, paused=false, status='Haritaya tıklayarak en az iki nokta ekleyin.';
 let line, cursor, markers=[], timer, pending, lastKey='', lastSent=0, container, lastMouse=null;
 let coordFormat='dd',latInput='',lonInput='',latDirection='N',lonDirection='E',coordError='',coordMessage='';
 const coordinateExamples={dd:['41.1592','27.8000'],dm:['41 9.552','27 48.000'],dms:['41 15 53N','27 45 20']};
 function handlePanelKey(event){
  const input=event.target;
  if(!input?.matches?.('input,textarea,select'))return;
  event.stopPropagation();
  if((event.key===' '||event.code==='Space')&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.isComposing&&input.matches('input[type="text"],textarea')){
   event.preventDefault();
   const start=input.selectionStart??input.value.length,end=input.selectionEnd??start;
   input.setRangeText(' ',start,end,'end');
   input.dispatchEvent(new Event('input',{bubbles:true}));
  }
 }
 function parseCoordinate(text,format,axis,direction){
  let input=text.trim();
  const suffix=input.match(/[NSEW]$/i)?.[0]?.toUpperCase();
  if(suffix){
   if(!(axis==='lat'?['N','S']:['E','W']).includes(suffix))throw new Error('Enlem N/S, boylam E/W ile bitmelidir.');
   direction=suffix;input=input.slice(0,-1).trim();
  }
  const raw=input.replace(/,/g,'.').replace(/[°º′'″"’]/g,' ').trim();
  const parts=raw.split(/\s+/);
  const count={dd:1,dm:2,dms:3}[format];
  if(!raw||parts.length!==count||parts.some(x=>!/^[-+]?\d+(?:\.\d+)?$/.test(x)))throw new Error(`${axis==='lat'?'Enlem':'Boylam'}: seçilen biçime uygun sayılar girin.`);
  const nums=parts.map(Number),[deg,min=0,sec=0]=nums;
  if(format!=='dd'&&!Number.isInteger(deg))throw new Error('Derece tam sayı olmalı.');
  if(format==='dms'&&!Number.isInteger(min))throw new Error('DMS biçiminde dakika tam sayı olmalı.');
  if(min<0||min>=60||sec<0||sec>=60)throw new Error('Dakika ve saniye 0 dahil, 60 hariç aralıkta olmalı.');
  const limit=axis==='lat'?90:180;
  const abs=Math.abs(deg)+min/60+sec/3600;
  if(!Number.isFinite(abs)||abs>limit)throw new Error(`${axis==='lat'?'Enlem 90':'Boylam 180'} dereceyi aşamaz.`);
  const negative=raw.startsWith('-')||direction==='S'||direction==='W';
  return (negative?-1:1)*abs;
 }
 function addCoordinate(){
  coordError='';coordMessage='';
  try{
   const lat=parseCoordinate(latInput,coordFormat,'lat',latDirection);
   const lon=parseCoordinate(lonInput,coordFormat,'lon',lonDirection);
   stopTouchInspect();cancelPending();drawing=true;paused=false;lastMouse=null;lastKey='';
   points=[...points,{lat,lon}];redraw();save();
   latInput='';lonInput='';
   coordMessage=`${points.length}. nokta eklendi: ${lat.toFixed(6)}, ${lon.toFixed(6)}`;
   status='Başka nokta ekleyin veya Rotayı tamamla düğmesine basın.';
   if(points.length>1)map.fitBounds(points.map(p=>[p.lat,p.lon]),{padding:[45,45],maxZoom:11,animate:false});
   else map.setView([lat,lon],Math.max(map.getZoom(),7),{animate:false});
  }catch(err){coordError=err?.message||String(err);}
 }
 function changeFormat(){coordError='';coordMessage='';}

 let importBusy=false,importError='',importInfo='',importRoutes=[],selectedImport=0,routeTitle='Rotam',fileInput;
 const encoder=new TextEncoder();
 const MAX_FILE=20*1024*1024,MAX_KML=20*1024*1024,MAX_POINTS=2000;
 function readCoordinateList(text,spaceSeparated=false){
  return text.trim().split(/\s*\n\s*|\s+(?=[-+\d.]+,)/).filter(Boolean).map(tuple=>{
   const pieces=tuple.trim().split(spaceSeparated?/\s+/:/,/);
   if(pieces.length<2||!pieces[0].trim()||!pieces[1].trim())throw new Error('Dosyada eksik koordinat var.');
   const lon=Number(pieces[0]),lat=Number(pieces[1]);
   if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)throw new Error('Dosyada geçersiz enlem veya boylam var.');
   return {lat,lon};
  });
 }
 function parseKML(text,fileName){
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if(doc.getElementsByTagName('parsererror').length||doc.documentElement.localName!=='kml')throw new Error('Geçerli bir KML dosyası okunamadı.');
  const elements=(root,name)=>Array.from(root.getElementsByTagNameNS('*',name));
  const placemarks=elements(doc,'Placemark'),routes=[],waypoints=[];
  for(const pm of placemarks){
   const title=Array.from(pm.childNodes).find(el=>el.nodeType===1&&el.localName==='name')?.textContent?.trim()||fileName;
   for(const line of elements(pm,'LineString')){
    const text=elements(line,'coordinates')[0]?.textContent||'';
    const points=readCoordinateList(text);
    if(points.length>=2)routes.push({name:title,points});
   }
   for(const track of elements(pm,'Track')){
    const points=elements(track,'coord').flatMap(el=>readCoordinateList(el.textContent||'',true));
    if(points.length>=2)routes.push({name:title,points});
   }
   for(const point of elements(pm,'Point')){
    const value=readCoordinateList(elements(point,'coordinates')[0]?.textContent||'');
    if(value.length)waypoints.push(value[0]);
   }
  }
  if(!routes.length&&waypoints.length>=2)routes.push({name:fileName+' (nokta sırası)',points:waypoints});
  if(!routes.length)throw new Error('Dosyada rota çizgisi veya en az iki nokta bulunamadı.');
  if(routes.some(r=>r.points.length>MAX_POINTS))throw new Error('Bir rota en fazla 2000 nokta içerebilir.');
  return routes;
 }
 async function unzipKML(bytes){
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),n=bytes.length;
  let eocd=-1;
  for(let i=n-22;i>=Math.max(0,n-65557);i--)if(v.getUint32(i,true)===0x06054b50){eocd=i;break;}
  if(eocd<0)throw new Error('KMZ arşivi açılamadı.');
  if(v.getUint16(eocd+4,true)||v.getUint16(eocd+6,true))throw new Error('Çok parçalı KMZ desteklenmiyor.');
  let at=v.getUint32(eocd+16,true),count=v.getUint16(eocd+10,true),entries=[];
  if(count===65535)throw new Error('ZIP64 arşivi desteklenmiyor.');
  for(let i=0;i<count;i++){
   if(at+46>n||v.getUint32(at,true)!==0x02014b50)throw new Error('KMZ dizini bozuk.');
   const flags=v.getUint16(at+8,true),method=v.getUint16(at+10,true),size=v.getUint32(at+20,true),plain=v.getUint32(at+24,true),nameLen=v.getUint16(at+28,true),extra=v.getUint16(at+30,true),comment=v.getUint16(at+32,true),offset=v.getUint32(at+42,true),crc=v.getUint32(at+16,true);
   const name=new TextDecoder().decode(bytes.subarray(at+46,at+46+nameLen));
   if(/\.kml$/i.test(name))entries.push({name,flags,method,size,plain,offset,crc});
   at+=46+nameLen+extra+comment;
  }
  entries.sort((a,b)=>(/(^|\/)doc\.kml$/i.test(b.name)?1:0)-(/(^|\/)doc\.kml$/i.test(a.name)?1:0));
  if(!entries.length)throw new Error('KMZ içinde KML dosyası yok.');
  let total=0;const results=[];
  for(const e of entries){
   total+=e.plain;if(total>MAX_KML)throw new Error('KMZ içindeki KML verisi çok büyük (en fazla 20 MB).');
   if(e.flags&1)throw new Error('Şifreli KMZ dosyası desteklenmiyor.');
   if(e.offset+30>n||v.getUint32(e.offset,true)!==0x04034b50)throw new Error('KMZ dosya başlığı bozuk.');
   const start=e.offset+30+v.getUint16(e.offset+26,true)+v.getUint16(e.offset+28,true);
   if(start+e.size>n)throw new Error('KMZ dosyası eksik.');
   const packed=bytes.subarray(start,start+e.size);let out;
   if(e.method===0)out=packed;
   else if(e.method===8){
    if(typeof DecompressionStream==='undefined')throw new Error('Bu tarayıcı KMZ açmayı desteklemiyor. KML kullanın.');
    const reader=new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks=[];let len=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;len+=value.length;if(len>MAX_KML||len>e.plain){await reader.cancel();throw new Error('KMZ açılmış veri sınırını aşıyor.');}chunks.push(value);}}
    finally{reader.releaseLock();}
    out=new Uint8Array(len);let pos=0;for(const c of chunks){out.set(c,pos);pos+=c.length;}
   }else throw new Error('KMZ sıkıştırma yöntemi desteklenmiyor.');
   if(out.length!==e.plain||crc32(out)!==e.crc)throw new Error('KMZ veri bütünlüğü kontrolü başarısız.');
   results.push({name:e.name,text:new TextDecoder().decode(out)});
  }
  return results;
 }
 function crc32(data){let crc=0xffffffff;for(const b of data){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
 function makeKMZ(text){
  const name=encoder.encode('doc.kml'),data=encoder.encode(text),crc=crc32(data),local=new Uint8Array(30+name.length+data.length),lv=new DataView(local.buffer);
  lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(12,33,true);lv.setUint32(14,crc,true);lv.setUint32(18,data.length,true);lv.setUint32(22,data.length,true);lv.setUint16(26,name.length,true);local.set(name,30);local.set(data,30+name.length);
  const central=new Uint8Array(46+name.length),cv=new DataView(central.buffer);
  cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(14,33,true);cv.setUint32(16,crc,true);cv.setUint32(20,data.length,true);cv.setUint32(24,data.length,true);cv.setUint16(28,name.length,true);central.set(name,46);
  const end=new Uint8Array(22),ev=new DataView(end.buffer);ev.setUint32(0,0x06054b50,true);ev.setUint16(8,1,true);ev.setUint16(10,1,true);ev.setUint32(12,central.length,true);ev.setUint32(16,local.length,true);
  return new Blob([local,central,end],{type:'application/vnd.google-earth.kmz'});
 }
 function kmlText(){
  const escape=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${escape(routeTitle||'Rotam')}</name><Style id="route"><LineStyle><color>ff00b7ff</color><width>4</width></LineStyle></Style><Placemark><name>${escape(routeTitle||'Rotam')}</name><styleUrl>#route</styleUrl><LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode><coordinates>${points.map(p=>`${p.lon},${p.lat},0`).join(' ')}</coordinates></LineString></Placemark></Document></kml>`;
 }
 function exportRoute(format){
  if(points.length<2)return;
  const text=kmlText(),blob=format==='kmz'?makeKMZ(text):new Blob([text],{type:'application/vnd.google-earth.kml+xml;charset=utf-8'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=(routeTitle.trim()||'Rotam').replace(/[\\/:*?"<>|]/g,'_')+'.'+format;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 async function importFile(event){
  const file=event.target.files?.[0];if(!file)return;
  importBusy=true;importError='';importInfo='';importRoutes=[];
  try{
   if(file.size>MAX_FILE)throw new Error('Dosya en fazla 20 MB olabilir.');
   const ext=file.name.split('.').pop().toLowerCase();
   if(!['kml','kmz'].includes(ext))throw new Error('KML veya KMZ dosyası seçin.');
   const docs=ext==='kmz'?await unzipKML(new Uint8Array(await file.arrayBuffer())):[{name:file.name,text:await file.text()}];
   const routes=docs.flatMap(d=>parseKML(d.text,d.name));
   importRoutes=routes;selectedImport=0;importInfo=`${routes.length} rota bulundu. Seçip Haritada aç düğmesine basın.`;
  }catch(err){importError=err?.message||String(err);}
  finally{importBusy=false;event.target.value='';}
 }
 function applyImported(){
  const route=importRoutes[Number(selectedImport)];if(!route)return;
  stopTouchInspect();cancelPending();points=route.points.map(p=>({...p}));routeTitle=route.name;lastKey='';lastMouse=null;paused=false;
  if(cursor){map.removeLayer(cursor);cursor=null;}
  redraw();save();finish();map.fitBounds(points.map(p=>[p.lat,p.lon]),{padding:[45,45],maxZoom:11,animate:false});
  importInfo=`${route.name}: ${points.length} nokta haritada açıldı.`;
 }

 let drag=null,panelObserver;
 const positionKey='windy-route-weather-panel-position';
 function placePanel(x,y,persist=false){
  if(!panel)return;
  const rect=panel.getBoundingClientRect();
  const left=Math.max(8,Math.min(x,Math.max(8,window.innerWidth-rect.width-8)));
  const top=Math.max(8,Math.min(y,Math.max(8,window.innerHeight-Math.min(rect.height,window.innerHeight-16)-8)));
  panel.style.left=left+'px';panel.style.top=top+'px';panel.style.right='auto';
  panel.style.maxHeight=Math.max(80,window.innerHeight-top-12)+'px';
  if(persist)try{localStorage.setItem(positionKey,JSON.stringify({x:left,y:top}));}catch{}
 }
 function clampPanel(){if(!panel)return;const r=panel.getBoundingClientRect();placePanel(r.left,r.top);}
 function startDrag(event){
  if(event.button!==0||event.target.closest('button,input,select'))return;
  const r=panel.getBoundingClientRect();drag={id:event.pointerId,x:event.clientX-r.left,y:event.clientY-r.top};
  event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();event.stopPropagation();cancelPending();
 }
 function dragMove(event){
  if(!drag||event.pointerId!==drag.id)return;
  placePanel(event.clientX-drag.x,event.clientY-drag.y);event.preventDefault();event.stopPropagation();
 }
 function endDrag(event){
  if(!drag||event.pointerId!==drag.id)return;
  drag=null;const r=panel.getBoundingClientRect();placePanel(r.left,r.top,true);
 }

 let flightAltitude='',altitudeUnit='ft',altitudeReference='amsl',altitudeEnabled=false,altitudeMessage='',altitudeOverlay,altitudeTimer;
 // Matches Windy's current meteogram altitude scale: 0–300 m = 10%,
 // 300–5500 m = 60%, 5500–13000 m = 30%, measured above model terrain.
 function cloudHeightRatio(heightAboveTerrain){
  const h=heightAboveTerrain;
  if(h<0||h>13000)return null;
  if(h<=300)return h/300*.1;
  if(h<=5500)return .1+(h-300)/5200*.6;
  return .7+(h-5500)/7500*.3;
 }
 function terrainFromLabel(text){
  const normalized=text.replace(/\u00a0/g,' ');
  const meters=normalized.match(/(-?[\d][\d\s,.]*)\s*m\b/i);
  if(meters)return Number(meters[1].replace(/[\s,]/g,''));
  const feet=normalized.match(/(-?[\d][\d\s,.]*)\s*ft\b/i);
  return feet?Number(feet[1].replace(/[\s,]/g,''))*.3048:null;
 }
 function saveAltitude(){try{localStorage.setItem('rw-flight-altitude',JSON.stringify({value:flightAltitude,unit:altitudeUnit,reference:altitudeReference,enabled:altitudeEnabled}));}catch{}}
 function enableAltitude(){altitudeEnabled=true;saveAltitude();updateAltitudeLine();}
 function hideAltitude(){altitudeEnabled=false;saveAltitude();altitudeMessage='';if(altitudeOverlay)altitudeOverlay.style.display='none';}
 function updateAltitudeLine(){
  if(!altitudeOverlay)return;
  altitudeOverlay.style.display='none';
  if(!altitudeEnabled)return;
  const value=Number(String(flightAltitude).replace(',','.'));
  if(String(flightAltitude).trim()===''||!Number.isFinite(value)||value<0){altitudeMessage='Sıfır veya daha büyük bir irtifa girin.';return;}
  const meters=altitudeUnit==='ft'?value*.3048:value;
  const root=document.getElementById('plugin-detail');
  const rows=root?Array.from(root.querySelectorAll('.tr--rainClouds')):[];
  const row=rows.find(el=>el.getBoundingClientRect().height>20);
  if(!row){altitudeMessage='Alttaki tahmin panelinde Meteogram görünümünü açın.';return;}
  const label=root.querySelector('.legend__elevation');
  const terrain=label?terrainFromLabel(label.textContent||''):null;
  if(terrain===null||!Number.isFinite(terrain)){altitudeMessage='Konumun arazi yüksekliği bekleniyor; Meteogram ölçeği okunamadı.';return;}
  const ground=Math.max(0,terrain),agl=altitudeReference==='agl'?meters:meters-ground;
  const ratio=cloudHeightRatio(agl);
  if(ratio===null){altitudeMessage=agl<0?'Girilen irtifa bu konumda model arazisinin altında.':'Girilen irtifa grafiğin üst sınırının üzerinde (arazi + 13.000 m).';return;}
  const rect=row.getBoundingClientRect(),table=row.closest('.forecast-table');
  if(!table){altitudeMessage='Meteogram çizim alanı bulunamadı.';return;}
  // Some Windy layout ancestors are zero-sized positioning hosts. Their
  // rectangles do not describe the visible forecast and must not clip the guide.
  const canvas=table.querySelector?.('.forecast-table__canvas');
  const canvasRect=canvas?.getBoundingClientRect();
  const tableRect=table.getBoundingClientRect();
  const chart=canvasRect&&canvasRect.right>canvasRect.left?canvasRect:tableRect;
  const legend=Array.from(root.querySelectorAll('.legend')).map(el=>el.getBoundingClientRect()).find(r=>r.width>30&&r.height>20);
  const detail=root.getBoundingClientRect?.();
  let left=Math.max(0,chart.left,legend?legend.right:0),right=Math.min(window.innerWidth,chart.right);
  if(detail&&detail.width>100){left=Math.max(left,detail.left);right=Math.min(right,detail.right);}
  const y=rect.bottom-ratio*rect.height;
  if(right<=left||y<0||y>window.innerHeight){altitudeMessage='Meteogramı görünür alana kaydırın; çizim alanı bekleniyor.';return;}
  altitudeOverlay.style.left=left+'px';altitudeOverlay.style.top=y+'px';altitudeOverlay.style.width=(right-left)+'px';altitudeOverlay.style.display='block';
  altitudeOverlay.firstElementChild.textContent=`${value.toLocaleString('tr-TR')} ${altitudeUnit} ${altitudeReference.toUpperCase()}`;
  altitudeMessage=`Turuncu çizgi etkin · Model arazisi: ${Math.round(ground)} m`;
 }

 let mobile=false,panelCollapsed=false,touchInspect=false,touchPointer=null,mobileQuery,lockedControls=[],oldTouchAction;
 function refreshMobile(){
  const next=!!mobileQuery?.matches;
  if(next!==mobile){mobile=next;panelCollapsed=next;if(!next)stopTouchInspect();}
  clampPanel();
 }
 function stopTouchInspect(){
  touchInspect=false;if(touchPointer!==null&&container?.hasPointerCapture?.(touchPointer))container.releasePointerCapture(touchPointer);touchPointer=null;cancelPending();
  for(const item of lockedControls)if(item.enabled)item.control.enable();
  lockedControls=[];
  if(container&&oldTouchAction!==undefined){container.style.touchAction=oldTouchAction;oldTouchAction=undefined;}
 }
 function toggleTouchInspect(){
  if(touchInspect){stopTouchInspect();status='Haritayı normal şekilde kaydırabilirsiniz.';return;}
  if(drawing||points.length<2)return;
  touchInspect=true;paused=false;lastMouse=null;panelCollapsed=true;
  const controls=[map.dragging,map.touchZoom,map.maplibreMap?.dragPan,map.maplibreMap?.touchZoomRotate].filter(Boolean);
  for(const control of new Set(controls))if(typeof control.disable==='function'){
   const enabled=typeof control.enabled==='function'?control.enabled():typeof control.isEnabled==='function'?control.isEnabled():false;
   lockedControls.push({control,enabled});if(enabled)control.disable();
  }
  oldTouchAction=container.style.touchAction;container.style.touchAction='none';
  status='Sarı rotaya dokunun veya parmağınızı rota üzerinde sürükleyin.';
 }
 function touchStart(event){
  if(!touchInspect||!['touch','pen'].includes(event.pointerType)||touchPointer!==null)return;
  touchPointer=event.pointerId;lastMouse=null;
  container.setPointerCapture?.(event.pointerId);
  event.preventDefault();event.stopImmediatePropagation();moveTouch(event);
 }
 function moveTouch(event){try{track(event);}catch(err){status='Dokunmatik takip: '+err.message;}}
 function touchMove(event){
  if(!touchInspect||event.pointerId!==touchPointer)return;
  event.preventDefault();event.stopImmediatePropagation();moveTouch(event);
 }
 function touchCaptureLost(event){if(event.pointerId===touchPointer){touchPointer=null;cancelPending();}}
 function touchEnd(event){
  if(event.pointerId!==touchPointer)return;
  event.preventDefault();event.stopImmediatePropagation();
  if(event.type!=='pointercancel'){moveTouch(event);clearTimeout(timer);timer=undefined;send();}else cancelPending();
  touchPointer=null;
  if(container.hasPointerCapture?.(event.pointerId))container.releasePointerCapture(event.pointerId);
 }

 let panel,host,hostDisplay;
 const storageKey='windy-route-weather-v1';
 function cancelPending(){clearTimeout(timer);timer=undefined;pending=null;}
 function save(){try{localStorage.setItem(storageKey,JSON.stringify(points));}catch{}}
 function redraw(){
  if(line) map.removeLayer(line);
  markers.forEach(m=>map.removeLayer(m)); markers=[];
  if(points.length>1) line=L.polyline(points.map(p=>[p.lat,p.lon]),{color:'#ffb700',weight:5,opacity:0.95,interactive:false}).addTo(map);
  else line=null;
  points.forEach((p,i)=>markers.push(L.marker([p.lat,p.lon],{icon:L.divIcon({className:'route-weather-dot',html:String(i+1),iconSize:[22,22],iconAnchor:[11,11]}),interactive:false}).addTo(map)));
 }
 function add(p){if(!drawing)return;points=[...points,{lat:p.lat,lon:p.lon}];redraw();save();}
 function finish(){if(points.length<2)return;drawing=false;paused=false;status='Fareyi sarı rota üzerinde gezdirin.';}
 function edit(){stopTouchInspect();cancelPending();drawing=true;status='Haritaya tıklayarak rotaya nokta ekleyin.';}
 function undo(){cancelPending();points=points.slice(0,-1);drawing=true;redraw();save();}
 function clear(){stopTouchInspect();cancelPending();points=[];drawing=true;redraw();save();if(cursor){map.removeLayer(cursor);cursor=null;}lastKey='';status='Yeni rota için haritaya tıklayın.';}
 function send(){
  timer=undefined;
  if(!pending || drawing || paused)return;
  const p=pending;pending=null;
  const key=p.lat.toFixed(3)+','+p.lon.toFixed(3);
  if(key===lastKey)return;
  try {
   const location={lat:p.lat,lon:p.lon,source:'singleclick'};
   if(!mobile&&store.get('detailLocation')){
    // Same event used by Windy's own map clicks while detail is already open.
    // Avoid the external open lifecycle and its map/picker positioning.
    singleclick.emit('detail',location);
   }else{
    bcast.emit('rqstOpen','detail',location);
   }
   lastKey=key;lastSent=Date.now();status=`Tahmin konumu: ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
  }
  catch {status='Windy tahmin paneli açılamadı. Eklentiyi yeniden açın.';}
 }
 function screenPoint(v,i){
  const el=markers[i]?.getElement?.();
  if(el){const r=el.getBoundingClientRect();if(r.width&&r.height)return {x:r.left+r.width/2,y:r.top+r.height/2};}
  const r=container.getBoundingClientRect();
  const p=typeof map.latLngToContainerPoint==='function'
   ?map.latLngToContainerPoint([v.lat,v.lon]):map.project([v.lon,v.lat]);
  return {x:p.x+r.left,y:p.y+r.top};
 }
 function move(e){
  if(mobile)return;
  try{track(e);}catch(err){cancelPending();status='Takip hatası: '+(err?.message||String(err));}
 }
 function track(e){
  if(drawing||paused||points.length<2)return;
  if(e.target?.closest?.('.route-panel'))return;
  if(lastMouse&&Math.hypot(e.clientX-lastMouse.x,e.clientY-lastMouse.y)<2)return;
  lastMouse={x:e.clientX,y:e.clientY};
  const p={x:e.clientX,y:e.clientY};
  const hit=nearestOnSegments(p,points.map(screenPoint));
  if(!hit || hit.distance>32){cancelPending();status=mobile?'Sarı rota üzerinde dokunarak veya sürükleyerek konum seçin.':'Fare algılandı — sarı çizgi üzerinde gezdirin.';return;}
  const a=points[hit.segment],b=points[hit.segment+1],t=hit.t;
  const merc=lat=>Math.log(Math.tan(Math.PI/4+Math.max(-85,Math.min(85,lat))*Math.PI/360));
  let delta=b.lon-a.lon;if(delta>180)delta-=360;if(delta< -180)delta+=360;
  const lat=(2*Math.atan(Math.exp(merc(a.lat)*(1-t)+merc(b.lat)*t))-Math.PI/2)*180/Math.PI;
  const lng=((a.lon+delta*t+540)%360)-180;
  const ll={lat,lng};
  status=`Takip: ${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)}`;
  if(!cursor)cursor=L.marker([ll.lat,ll.lng],{icon:L.divIcon({className:'route-weather-cursor',html:'',iconSize:[16,16],iconAnchor:[8,8]}),interactive:false}).addTo(map);
  else cursor.setLatLng([ll.lat,ll.lng]);
  pending={lat:ll.lat,lon:ll.lng};
  // Latest position wins; avoid a request for every mouse event.
  if(!timer)timer=setTimeout(send,Math.max(180,1000-(Date.now()-lastSent)));
 }
 function pause(){paused=!paused;cancelPending();status=paused?'Tahmin sabitlendi. Devam et ile takibi açın.':'Fareyi rota üzerinde gezdirin.';}
 function leave(){cancelPending();}
 onMount(()=>{
  altitudeOverlay=document.createElement('div');altitudeOverlay.className='rw-altitude-guide';altitudeOverlay.setAttribute('aria-hidden','true');altitudeOverlay.appendChild(document.createElement('span'));document.body.appendChild(altitudeOverlay);
  try{const a=JSON.parse(localStorage.getItem('rw-flight-altitude')||'null');if(a){flightAltitude=String(a.value??'');altitudeUnit=a.unit==='m'?'m':'ft';altitudeReference=a.reference==='agl'?'agl':'amsl';altitudeEnabled=!!a.enabled;}}catch{}
  altitudeTimer=setInterval(updateAltitudeLine,250);

  // Keep controls outside Windy's bottom embedded host so forecast cannot clip them.
  if(panel)document.body.appendChild(panel);
  host=pluginRootElement||document.getElementById('plugin-'+config.name);
  if(host){hostDisplay=host.style.display;host.style.display='none';}
  try{const pos=JSON.parse(localStorage.getItem(positionKey)||'null');if(pos&&Number.isFinite(pos.x)&&Number.isFinite(pos.y))placePanel(pos.x,pos.y);}catch{}
  window.addEventListener('resize',clampPanel);
  if(typeof ResizeObserver!=='undefined'){panelObserver=new ResizeObserver(clampPanel);panelObserver.observe(panel);}
  try{const data=JSON.parse(localStorage.getItem(storageKey)||'[]');if(Array.isArray(data)&&data.length<=2000&&data.every(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&Math.abs(p.lat)<=90&&Math.abs(p.lon)<=180))points=data;}catch{}
  redraw();if(points.length>1)finish();
  container=map.getContainer();
  mobileQuery=window.matchMedia('(max-width: 768px), (pointer: coarse)');refreshMobile();mobileQuery.addEventListener('change',refreshMobile);
  container.addEventListener('pointerdown',touchStart,{capture:true,passive:false});
  container.addEventListener('pointermove',touchMove,{capture:true,passive:false});
  container.addEventListener('pointerup',touchEnd,{capture:true,passive:false});
  container.addEventListener('pointercancel',touchEnd,{capture:true,passive:false});
  container.addEventListener('lostpointercapture',touchCaptureLost,true);
  singleclick.on(config.name,add);document.addEventListener('mousemove',move,true);container.addEventListener('mouseleave',leave);
 });
 onDestroy(()=>{stopTouchInspect();mobileQuery?.removeEventListener('change',refreshMobile);container?.removeEventListener('pointerdown',touchStart,true);container?.removeEventListener('pointermove',touchMove,true);container?.removeEventListener('pointerup',touchEnd,true);container?.removeEventListener('pointercancel',touchEnd,true);container?.removeEventListener('lostpointercapture',touchCaptureLost,true);clearInterval(altitudeTimer);altitudeOverlay?.remove();window.removeEventListener('resize',clampPanel);panelObserver?.disconnect();if(host)host.style.display=hostDisplay||'';panel?.remove();cancelPending();singleclick.off(config.name,add);document.removeEventListener('mousemove',move,true);container?.removeEventListener('mouseleave',leave);if(line)map.removeLayer(line);if(cursor)map.removeLayer(cursor);markers.forEach(m=>map.removeLayer(m));});
</script>
<div class="route-panel" class:is-mobile={mobile} bind:this={panel} on:keydown={handlePanelKey}>
 <div class="panel-header" title="Taşımak için başlıktan tutup sürükleyin" on:pointerdown={startDrag} on:pointermove={dragMove} on:pointerup={endDrag} on:pointercancel={endDrag} on:lostpointercapture={endDrag}><strong>Uçuş Rotası Hava Durumu · v0.5.0</strong><span class="count">{points.length} nokta</span>{#if mobile}<button type="button" class="settings-toggle" on:click={()=>panelCollapsed=!panelCollapsed}>{panelCollapsed?'Ayarlar':'Küçült'}</button>{/if}<button type="button" class="close-panel" aria-label="Eklentiyi kapat" on:click={()=>bcast.emit('rqstClose',config.name)}>×</button></div>
 {#if mobile}<div class="mobile-controls">
  {#if drawing}<button type="button" on:click={finish} disabled={points.length<2}>Rotayı tamamla</button>{:else}<button type="button" class:inspect-active={touchInspect} aria-pressed={touchInspect} on:click={toggleTouchInspect}>{touchInspect?'Haritayı kaydır':'Rotayı incele'}</button>{/if}
  <span>{touchInspect?'Dokunarak konum seçimi açık':`${points.length} rota noktası`}</span>
 </div>{/if}
 {#if !mobile||!panelCollapsed}
 <div class="buttons">
  {#if drawing}<button on:click={finish} disabled={points.length<2}>Rotayı tamamla</button>{:else}<button on:click={edit}>Rota düzenle</button><button on:click={pause}>{paused?'Devam et':'Tahmini sabitle'}</button>{/if}
<button on:click={clear} disabled={!points.length}>Temizle</button>
 </div>
 <details class="coordinates" open>
  <summary>Uçuş irtifası çizgisi</summary>
  <form on:submit|preventDefault={enableAltitude}>
   <label for="rw-flight-alt">İrtifa</label>
   <div class="coord-row"><input id="rw-flight-alt" type="text" inputmode="decimal" bind:value={flightAltitude} placeholder="Örnek: 20000"/><select aria-label="İrtifa birimi" bind:value={altitudeUnit}><option value="ft">feet (ft)</option><option value="m">metre (m)</option></select></div>
   <label for="rw-alt-ref">İrtifa referansı</label>
   <select id="rw-alt-ref" bind:value={altitudeReference}><option value="amsl">Deniz seviyesine göre (AMSL)</option><option value="agl">Yerden yükseklik (AGL)</option></select>
   <div class="buttons"><button type="submit">Çizgiyi göster</button><button type="button" on:click={hideAltitude}>Çizgiyi gizle</button></div>
   {#if altitudeMessage}<small role="status">{altitudeMessage}</small>{/if}
   <small>Meteogramdaki gri bulut alanını turuncu çizgi boyunca inceleyin. ft/m ölçeği yaklaşık irtifa karşılığıdır; çizgi uçuş uygunluğu kararı vermez.</small>
  </form>
 </details>
 <details class="coordinates">
  <summary>Koordinat girerek nokta ekle</summary>
  <form on:submit|preventDefault={addCoordinate}>
   <label for="rw-format">Koordinat biçimi</label>
   <select id="rw-format" bind:value={coordFormat} on:change={changeFormat}>
    <option value="dd">Ondalık derece (DD)</option>
    <option value="dm">Derece–Dakika (DM)</option>
    <option value="dms">Derece–Dakika–Saniye (DMS)</option>
   </select>
   <label for="rw-lat">Enlem</label>
   <div class="coord-row"><input id="rw-lat" type="text" bind:value={latInput} placeholder={coordinateExamples[coordFormat][0]} required autocomplete="off"/><select aria-label="Enlem yönü" bind:value={latDirection}><option value="N">Kuzey (N)</option><option value="S">Güney (S)</option></select></div>
   <label for="rw-lon">Boylam</label>
   <div class="coord-row"><input id="rw-lon" type="text" bind:value={lonInput} placeholder={coordinateExamples[coordFormat][1]} required autocomplete="off"/><select aria-label="Boylam yönü" bind:value={lonDirection}><option value="E">Doğu (E)</option><option value="W">Batı (W)</option></select></div>
   <small>{coordFormat==='dd'?'Örnek: 41.1592':coordFormat==='dm'?'Örnek: 41° 9.552′ veya 41 9.552':'Örnek: 41° 9′ 33.12″ veya 41 15 53N'}. Ondalık ayıracı nokta veya virgül olabilir. Eksi işaret güney/batı anlamına gelir.</small>
   <button type="submit">Noktayı rotaya ekle</button>
   {#if coordError}<p class="error" role="alert">{coordError}</p>{/if}
   {#if coordMessage}<p class="success" role="status">{coordMessage}</p>{/if}
  </form>
  {#if points.length}<ol class="point-list">{#each points as point}<li>{point.lat.toFixed(6)}, {point.lon.toFixed(6)}</li>{/each}</ol>{/if}
 </details>
 <details class="coordinates">
  <summary>KML / KMZ içe ve dışa aktar</summary>
  <div class="file-tools">
   <label for="rw-import">Dosyadan rota ekle</label>
   <input id="rw-import" type="file" accept=".kml,.kmz" on:change={importFile} disabled={importBusy}/>
   <small>En fazla 20 MB / rota başına 2000 nokta. Açılan rota mevcut rotanın yerini alır.</small>
   {#if importBusy}<p role="status">Dosya okunuyor…</p>{/if}
   {#if importRoutes.length}
    <label for="rw-import-route">İçe aktarılacak rota</label>
    <select id="rw-import-route" bind:value={selectedImport}>{#each importRoutes as route,i}<option value={i}>{i+1}. {route.name} ({route.points.length} nokta)</option>{/each}</select>
    <button type="button" on:click={applyImported} disabled={importBusy}>Seçili rotayı haritada aç</button>
   {/if}
   {#if importError}<p class="error" role="alert">{importError}</p>{/if}
   {#if importInfo}<p class="success" role="status">{importInfo}</p>{/if}
   <label for="rw-route-name">Dışa aktarılacak rota adı</label>
   <input id="rw-route-name" type="text" bind:value={routeTitle} maxlength="100"/>
   <div class="buttons"><button type="button" on:click={()=>exportRoute('kml')} disabled={points.length<2}>KML indir</button><button type="button" on:click={()=>exportRoute('kmz')} disabled={points.length<2}>KMZ indir</button></div>
   <small>Rota çizgisi aktarılır; hava tahmini ve uçuş irtifası dosyaya eklenmez.</small>
  </div>
 </details>
 {/if}
 <p aria-live="polite">{status}</p>
 {#if !mobile||!panelCollapsed}<small>{mobile?'Rotayı incele modunda çizgiye dokunun; haritayı taşımak için Haritayı kaydır seçin.':'Çizgiye yakın gezin; alttaki Windy tahmini konuma göre değişir.'}</small>{/if}
</div>
<style>
 .route-panel{position:fixed;top:60px;right:64px;bottom:auto;z-index:1000;width:350px;box-sizing:border-box;background:#172331;color:white;padding:12px;border-radius:12px;max-width:360px;max-height:calc(100dvh - 84px);overflow-y:auto;overscroll-behavior:contain;font:13px/1.4 sans-serif;box-shadow:0 4px 18px #0005}
 @media(max-width:600px){.route-panel{top:92px;right:12px;width:calc(100vw - 24px);max-height:calc(100dvh - 120px);}}
 :global(.rw-altitude-guide){position:fixed;display:none;height:0;border-top:2px solid #ff8a00;z-index:450;pointer-events:none;box-shadow:0 0 2px white;} :global(.rw-altitude-guide span){position:absolute;left:8px;top:-18px;background:#fff2d9;color:#9a4300;border:1px solid #ff8a00;border-radius:3px;font:11px/14px sans-serif;padding:0 4px;white-space:nowrap;}
 .is-mobile{width:min(360px,calc(100vw - 24px));right:12px;top:70px;max-height:calc(100dvh - 100px)}.is-mobile .panel-header strong{font-size:12px}.is-mobile .count{display:none}.is-mobile input,.is-mobile select{font-size:16px}.is-mobile button{min-height:40px}.settings-toggle{font-size:12px;padding:5px 8px}.mobile-controls{display:flex;align-items:center;gap:8px;margin-top:8px}.mobile-controls span{font-size:11px;color:#c1ceda}.inspect-active{background:#ffbd24;color:#172331}
 .file-tools{display:grid;gap:7px;margin-top:8px}.file-tools input{width:100%}.file-tools select{width:100%}
 .panel-header{cursor:grab;touch-action:none;user-select:none;display:flex;align-items:center;gap:8px}.panel-header:active{cursor:grabbing}.panel-header strong{flex:1}.close-panel{padding:0 5px;border:0;background:transparent !important;color:white !important;font-size:22px;line-height:1}.panel-header .count{font-size:11px;white-space:nowrap}
 .coordinates{margin-top:10px;border-top:1px solid #526378;padding-top:8px}summary{cursor:pointer;color:#ffce54}form{display:grid;gap:5px;margin-top:8px}label{font-size:12px;color:#d8e2eb}.coord-row{display:flex;gap:6px}input,select{min-width:0;box-sizing:border-box;background:#26384b;color:white;border:1px solid #60748a;border-radius:5px;padding:7px;font:inherit}input{flex:1;width:55%}.coord-row select{width:110px}form>button{margin-top:5px}.error{color:#ffb4b4}.success{color:#9fe0b5}.point-list{max-height:100px;overflow-y:auto;margin:8px 0 0;padding-left:25px;font-size:11px}
 .count{float:right;color:#ffce54}.buttons{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}button{background:#33465b;color:white;border:1px solid #60748a;border-radius:6px;padding:7px 9px;cursor:pointer}button:first-child{background:#ffbd24;color:#172331}button:disabled{opacity:.4;cursor:default}p{margin:9px 0}small{color:#c1ceda}
 :global(.route-weather-dot), :global(.route-weather-cursor){transition:none !important;animation:none !important;pointer-events:none !important;}
 :global(.route-weather-dot){background:#ffbd24;color:#182635;border:2px solid white;border-radius:50%;text-align:center;line-height:18px;font-weight:bold;box-sizing:border-box}
 :global(.route-weather-cursor){background:#00d9ff;border:3px solid white;border-radius:50%;box-shadow:0 0 8px #000;box-sizing:border-box}
</style>
