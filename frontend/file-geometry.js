/* Bounded WGS84 normalization shared by the file worker and its tests. */
(function(root){
'use strict';
function normalize(input){
 const features=input?.type==='FeatureCollection'?input.features:input?.type==='Feature'?[input]:input?.coordinates||input?.type==='GeometryCollection'?[{type:'Feature',geometry:input,properties:{}}]:null;
 if(!Array.isArray(features)||!features.length)throw Error('No geographic features were found.');
 if(features.length>100000)throw Error('File exceeds the 100,000 feature processing limit.');
 let bbox=[Infinity,Infinity,-Infinity,-Infinity],vertices=0;
 const position=p=>{if(!Array.isArray(p)||p.length<2||!p.slice(0,3).every(Number.isFinite)||Math.abs(p[0])>180||Math.abs(p[1])>90)throw Error('Geometry must contain valid WGS84 longitude/latitude coordinates.');if(++vertices>1000000)throw Error('File exceeds the one million vertex processing limit.');bbox[0]=Math.min(bbox[0],p[0]);bbox[1]=Math.min(bbox[1],p[1]);bbox[2]=Math.max(bbox[2],p[0]);bbox[3]=Math.max(bbox[3],p[1]);return p.slice(0,3);};
 const line=(value,min)=>{if(!Array.isArray(value)||value.length<min)throw Error('Geometry has too few coordinates.');return value.map(position);};
 const ring=value=>{const result=line(value,4);if(result[0][0]!==result.at(-1)[0]||result[0][1]!==result.at(-1)[1])throw Error('Polygon rings must be closed.');return result;};
 function geometry(g,depth=0){
  if(!g||depth>8)throw Error('Invalid geometry or excessive collection depth.');
  let coordinates;
  switch(g.type){
   case 'Point':coordinates=position(g.coordinates);break;
   case 'MultiPoint':coordinates=line(g.coordinates,1);break;
   case 'LineString':coordinates=line(g.coordinates,2);break;
   case 'MultiLineString':if(!Array.isArray(g.coordinates))throw Error('Invalid lines');coordinates=g.coordinates.map(v=>line(v,2));break;
   case 'Polygon':if(!Array.isArray(g.coordinates)||!g.coordinates.length)throw Error('Invalid polygon');coordinates=g.coordinates.map(ring);break;
   case 'MultiPolygon':if(!Array.isArray(g.coordinates))throw Error('Invalid polygons');coordinates=g.coordinates.map(v=>{if(!Array.isArray(v)||!v.length)throw Error('Invalid polygon');return v.map(ring);});break;
   case 'GeometryCollection':if(!Array.isArray(g.geometries))throw Error('Invalid collection');return {type:g.type,geometries:g.geometries.map(v=>geometry(v,depth+1))};
   default:throw Error('Unsupported geometry type: '+String(g.type).slice(0,40));
  }
  return {type:g.type,coordinates};
 }
 const result=features.filter(f=>f?.geometry).map(f=>({type:'Feature',properties:f.properties&&typeof f.properties==='object'&&!Array.isArray(f.properties)?f.properties:{},geometry:geometry(f.geometry)}));
 if(!result.length||!vertices)throw Error('No geographic features were found.');
 return {fc:{type:'FeatureCollection',features:result},bbox,feature_count:result.length};
}
function csv(text){
 const rows=[];let row=[],value='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else if(!quoted&&value)throw Error('Invalid CSV quoting');else quoted=!quoted;}
 else if(c===','&&!quoted){row.push(value);value='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(v=>v!==''))rows.push(row);row=[];value='';}else value+=c;}
 if(quoted)throw Error('Unclosed CSV quote');row.push(value);if(row.some(v=>v!==''))rows.push(row);
 const headers=rows.shift()?.map(v=>v.replace(/^\uFEFF/,'').trim());if(!headers||!headers.includes('lat')||!headers.includes('lon'))throw Error('CSV requires lat and lon column headers.');
 if(rows.length>100000)throw Error('File exceeds the 100,000 feature processing limit.');
 return normalize({type:'FeatureCollection',features:rows.map((cells,i)=>{const lat=cells[headers.indexOf('lat')]?.trim(),lon=cells[headers.indexOf('lon')]?.trim();if(!lat||!lon||!Number.isFinite(Number(lat))||!Number.isFinite(Number(lon)))throw Error('Invalid latitude or longitude on CSV row '+(i+2));return {type:'Feature',properties:Object.fromEntries(headers.map((h,n)=>[h,cells[n]||''])),geometry:{type:'Point',coordinates:[Number(lon),Number(lat)]}};})});
}
function czml(data){
 if(!Array.isArray(data)||data.length>100000)throw Error('CZML must contain an array of packets.');
 const features=[];
 for(const packet of data){const value=packet.position?.cartographicDegrees;if(!Array.isArray(value))continue;const p=value.length===3?value:value.slice(1,4);if(p.length>=2)features.push({type:'Feature',properties:{name:packet.name||packet.id||'CZML position'},geometry:{type:'Point',coordinates:p.slice(0,3)}});}
 if(!features.length)throw Error('CZML has no supported cartographic positions.');return normalize({type:'FeatureCollection',features});
}
const value={normalize,csv,czml};if(typeof module!=='undefined'&&module.exports)module.exports=value;else root.GVFileGeometry=value;
})(typeof self!=='undefined'?self:globalThis);
