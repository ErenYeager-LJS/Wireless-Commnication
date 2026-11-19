/* Hallmark · pre-emit critique: P4 H4 E4 S5 R5 V4 */
import { memo, useLayoutEffect, useMemo, useRef, useEffect } from 'react';
import { Html, RoundedBox } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { SCENE as S } from './scene-theme';

type V3 = [number, number, number];
type Item = {p: V3; s: V3; r?: number};
type BatchName = 'stone' | 'stoneCool' | 'stoneWarm' | 'frame' | 'glass' | 'glassCool' | 'glassWarm' |
  'roof' | 'bronze' | 'pavement' | 'curb' | 'asphalt' | 'paint' | 'yellow' | 'lawn' | 'light' | 'metal' |
  'carWhite' | 'carBlue' | 'carBronze';
const palette: Record<BatchName, string> = {
  stone:S.stone, stoneCool:S.stoneCool, stoneWarm:S.stoneWarm, frame:S.concrete,
  glass:S.glass, glassCool:S.glassCool, glassWarm:S.glassWarm, roof:S.roof, bronze:S.bronze,
  pavement:S.pavement, curb:S.curb, asphalt:S.asphalt, paint:S.roadPaint, yellow:S.lanePaint,
  lawn:S.lawn, light:S.warmLight, metal:S.metal, carWhite:S.carWhite, carBlue:S.carBlue, carBronze:S.carBronze,
};
const specs = [
  {name:'综合指挥中心', p:[0,0,-1] as V3, w:10,d:8,floors:6, skin:'stone' as BatchName},
  {name:'通信研发中心', p:[-14,0,-9] as V3,w:9,d:6,floors:4,skin:'stoneCool' as BatchName},
  {name:'数据中心',p:[14,0,-10] as V3,w:8,d:6,floors:3,skin:'stone' as BatchName},
  {name:'智能制造车间',p:[-15,0,10] as V3,w:11,d:7,floors:2,skin:'stoneWarm' as BatchName},
  {name:'测试验证中心',p:[14,0,10] as V3,w:10,d:7,floors:3,skin:'stoneCool' as BatchName},
  {name:'能源保障站',p:[0,0,14] as V3,w:7,d:5,floors:2,skin:'stoneWarm' as BatchName},
];

function Instances({items, color, kind='box', glass=false, glow=false, transparent=false, texture}: {
  items:Item[]; color:string; kind?:'box'|'sphere'|'cylinder'; glass?:boolean; glow?:boolean; transparent?:boolean; texture?:THREE.Texture;
}) {
  const ref=useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(()=>{
    if(!ref.current)return;
    const transform=new THREE.Object3D();
    items.forEach((v,i)=>{transform.position.set(...v.p);transform.scale.set(...v.s);transform.rotation.set(0,v.r??0,0);transform.updateMatrix();ref.current!.setMatrixAt(i,transform.matrix);});
    ref.current!.instanceMatrix.needsUpdate=true;ref.current!.computeBoundingSphere();
  },[items]);
  if(!items.length)return null;
  return <instancedMesh ref={ref} args={[undefined,undefined,items.length]} castShadow={!glow} receiveShadow={!glass&&!glow}>
    {kind==='sphere'?<sphereGeometry args={[1,8,6]}/>:kind==='cylinder'?<cylinderGeometry args={[.75,1,1,7]}/>:<boxGeometry args={[1,1,1]}/>}
    <meshStandardMaterial color={color} roughness={glass?.24:.78} metalness={glass?.48:.12}
      envMapIntensity={glass?1.6:.35} emissive={glow||glass?color:S.sky} emissiveIntensity={glow?1.6:glass?.2:0}
      transparent={transparent} opacity={transparent?.16:1} depthWrite={!transparent}
      roughnessMap={texture} bumpMap={texture} bumpScale={texture?.025:0} />
  </instancedMesh>;
}

/** Static architecture is instanced by material, not one draw per window/tree. */
export const CampusEnvironment=memo(function CampusEnvironment({exploded,transparent}: {exploded:boolean;transparent:boolean}) {
  const texture=useMemo(()=>{
    const pixels=new Uint8Array(64*64*4);let seed=881;
    for(let i=0;i<pixels.length;i+=4){seed=(seed*16807)%2147483647;const c=180+seed%70;pixels[i]=pixels[i+1]=pixels[i+2]=c;pixels[i+3]=255;}
    const map=new THREE.DataTexture(pixels,64,64);map.wrapS=map.wrapT=THREE.RepeatWrapping;map.repeat.set(12,12);map.needsUpdate=true;return map;
  },[]);
  useEffect(()=>()=>texture.dispose(),[texture]);
  const model=useMemo(()=>{
    const batches={} as Record<BatchName,Item[]>;
    (Object.keys(palette) as BatchName[]).forEach(key=>{batches[key]=[];});
    const box=(name:BatchName,p:V3,s:V3,r?:number)=>batches[name].push({p,s,r});
    const trunks:Item[]=[], leaves:Item[][]=[[],[],[]];
    // A real road section: curb, footpath, dark asphalt, dashed lanes and crossings.
    const road=(x:number,z:number,length:number,width:number,vertical=false)=>{
      box('curb',[x,-.54,z],vertical?[width+2,.16,length]:[length,.16,width+2]);
      box('pavement',[x,-.45,z],vertical?[width+1.7,.05,length]:[length,.05,width+1.7]);
      box('asphalt',[x,-.4,z],vertical?[width,.035,length]:[length,.035,width]);
      for(let t=-length/2+1;t<length/2;t+=2.4){
        if(Math.abs(t)<3)continue;
        box('yellow',vertical?[x,-.374,z+t]:[x+t,-.374,z],vertical?[.075,.014,1.2]:[1.2,.014,.075]);
      }
    };
    road(0,4.8,61,3);road(0,-18,61,3);road(0,19,61,3);
    road(-7,0,39,2.5,true);road(7,0,39,2.5,true);
    for(const x of [-9.5,9.5])for(let i=-2;i<=2;i++)box('paint',[x,-.355,4.8+i*.48],[1.1,.015,.24]);
    for(const x of [-7,7])for(let i=-2;i<=2;i++)box('paint',[x+i*.48,-.354,2.3],[.24,.015,1.1]);
    for(const x of [-29,29])for(let z=-20;z<=22;z+=7)box('lawn',[x,-.43,z],[3,.12,5]);
    specs.forEach((b,index)=>{
      const [x,,z]=b.p;const floorHeight=1.05,step=floorHeight+(exploded?.65:0),top=(b.floors-1)*step+floorHeight;
      box('curb',[x,-.35,z],[b.w+1.6,.25,b.d+1.6]);
      box('pavement',[x,-.19,z],[b.w+1.35,.12,b.d+1.35]);
      for(let f=0;f<b.floors;f++){
        const y=f*step;
        box(b.skin,[x,y+.5,z],[b.w,.94,b.d]);
        box('frame',[x,y+.015,z],[b.w+.14,.09,b.d+.14]);
        // Recessed window bays and fine facade mullions on all four sides.
        for(const side of [-1,1]){
          const cols=Math.floor(b.w/.9);
          for(let col=0;col<cols;col++){
            const wx=x-b.w/2+(col+.5)*b.w/cols;
            const lit=(col*13+f*7+index*3+(side===1?1:0))%11;
            box(lit<2?'glassWarm':lit<6?'glassCool':'glass',[wx,y+.53,z+side*(b.d/2+.018)],[b.w/cols-.12,.62,.035]);
            box('frame',[wx-b.w/cols/2+.02,y+.51,z+side*(b.d/2+.06)],[.045,.84,.12]);
          }
          const rows=Math.floor(b.d/.9);
          for(let col=0;col<rows;col++){
            const wz=z-b.d/2+(col+.5)*b.d/rows;
            box((col+f*3+index)%7<2?'glassWarm':'glassCool',[x+side*(b.w/2+.018),y+.53,wz],[.035,.62,b.d/rows-.12]);
            box('frame',[x+side*(b.w/2+.06),y+.51,wz-b.d/rows/2+.02],[.12,.84,.045]);
          }
          box('bronze',[x,y+.94,z+side*(b.d/2+.07)],[b.w+.18,.045,.12]);
        }
      }
      box('roof',[x,top+.015,z],[b.w+.25,.14,b.d+.25]);
      for(const side of [-1,1]){
        box(b.skin,[x,top+.19,z+side*(b.d/2-.12)],[b.w,.28,.18]);
        box(b.skin,[x+side*(b.w/2-.12),top+.19,z],[.18,.28,b.d]);
      }
      // Plant rooms, air handling louvres and rooftop photovoltaic panels.
      for(let u=0;u<2;u++){
        box('metal',[x-2+u*1.6,top+.35,z-1],[1.15,.55,1.2]);
        for(let l=0;l<4;l++)box('frame',[x-2+u*1.6,top+.64,z-1.4+l*.26],[.95,.035,.08]);
      }
      if(index===5||index===2)for(let p=0;p<3;p++){
        box('frame',[x-1.8+p*1.65,top+.24,z+1.1],[1.5,.1,1.3]);
        box('glass',[x-1.8+p*1.65,top+.32,z+1.1],[1.4,.06,1.2]);
        for(let l=0;l<3;l++)box('frame',[x-2.2+p*1.65+l*.4,top+.355,z+1.1],[.025,.015,1.18]);
      }
      // Ground-floor glazed lobby, cantilever entrance and warm soffit.
      box('glass',[x,.42,z+b.d/2+.06],[1.7,.82,.07]);
      box('bronze',[x,1.05,z+b.d/2+.65],[2.5,.12,1.3]);
      box('light',[x,.97,z+b.d/2+.7],[2.2,.025,.8]);
      box('pavement',[x,-.16,z+b.d/2+1.1],[2.7,.12,1.6]);
      for(const side of [-1,1])box('lawn',[x+side*(b.w/2-1),-.08,z+b.d/2+.6],[1.6,.22,.6]);
    });
    // Parking bays and modestly detailed stationary vehicles.
    box('asphalt',[24,-.35,7],[9,.08,17]);
    for(let z=0;z<=14;z+=2.8)box('paint',[24,-.295,z],[8.5,.015,.07]);
    for(const [x,z,c] of [[22,1.4,'carWhite'],[26,4.2,'carBlue'],[22,7,'carBronze'],[26,9.8,'carWhite'],[22,12.6,'carBlue']] as const){
      box(c,[x,.12,z],[1.65,.55,2.3]);box('glass',[x,.5,z+.08],[1.42,.38,1.25]);
      box(c,[x,.72,z+.12],[1.45,.08,1.1]);
      for(const side of [-1,1]){box('metal',[x+side*.76,-.05,z-.72],[.22,.42,.48]);box('metal',[x+side*.76,-.05,z+.72],[.22,.42,.48]);}
      box('light',[x,.13,z-1.18],[1.3,.12,.035]);
    }
    // Canopy trees use several interlocking crowns instead of cones.
    const treePositions=[[-28,-20],[-23,-20],[-18,-20],[-9,-20],[7,-20],[21,-20],[27,-20],[-28,-13],[-28,-6],[-28,1],[-28,17],[-25,21],[-19,21],[-10,21],[8,22],[17,22],[28,21],[30,15],[30,-8],[30,-15],[-7,-12],[-7,10],[7,15],[8,-8]];
    treePositions.forEach(([x,z],i)=>{
      const h=1.35+(i%4)*.13;
      trunks.push({p:[x,h/2-.35,z],s:[.14,h,.14]});
      leaves[i%3].push({p:[x,h+.35,z],s:[.9,1.05,.85]});
      leaves[(i+1)%3].push({p:[x+.45,h+.05,z+.2],s:[.65,.77,.67]});
      leaves[(i+2)%3].push({p:[x-.38,h+.15,z-.2],s:[.64,.8,.66]});
      box('curb',[x,-.38,z],[1.5,.12,1.5]);
    });
    // Architectural bollards; emissive faces create highlights without dozens of lights.
    for(const x of [-3.35,3.35])for(const z of [-20,-13,-6,6,13,20]){
      box('metal',[x,.08,z],[.13,.95,.13]);box('light',[x,.49,z],[.2,.09,.2]);
    }
    for(const x of [-9,9])for(const z of [-16,4.8,17]){
      box('metal',[x,1.4,z],[.09,3.5,.09]);
      box('metal',[x+.3,3.12,z],[.75,.09,.11]);
      box('light',[x+.5,3.04,z],[.38,.035,.18]);
    }
    for(const x of [-21,20])for(const z of [-3,16]){
      box('bronze',[x,.12,z],[1.7,.1,.48]);
      box('bronze',[x,.43,z-.2],[1.7,.5,.08]);
      for(const side of [-1,1])box('metal',[x+side*.6,-.12,z],[.08,.42,.38]);
    }
    // Heliport marking on the workshop roof.
    const h=2.1+(exploded?.65:0);
    box('paint',[-15,h+.11,10],[.13,.015,1.8]);box('paint',[-13.9,h+.11,10],[.13,.015,1.8]);box('paint',[-14.45,h+.11,10],[1.1,.015,.13]);
    return {batches,trunks,leaves};
  },[exploded]);
  return <group name="architectural-campus">
    <RoundedBox args={[69,.8,54]} radius={.28} smoothness={2} position={[0,-1.02,0]} receiveShadow>
      <meshStandardMaterial color={S.foundation} roughness={.92}/>
    </RoundedBox>
    <RoundedBox args={[68,.12,53]} radius={.04} smoothness={2} position={[0,-.56,0]} receiveShadow>
      <meshStandardMaterial color={S.lawn} roughness={1} roughnessMap={texture}/>
    </RoundedBox>
    {Object.entries(model.batches).map(([key,items])=><Instances key={key} items={items} color={palette[key as BatchName]}
      glass={key.startsWith('glass')} glow={key==='light'||key==='glassWarm'}
      transparent={transparent&&['stone','stoneWarm','stoneCool','glass','glassWarm','glassCool','frame','roof','bronze'].includes(key)}
      texture={key==='asphalt'||key==='pavement'?texture:undefined}/>)}
    <Instances items={model.trunks} kind="cylinder" color={S.bark}/>
    {model.leaves.map((items,i)=><Instances key={i} items={items} kind="sphere" color={[S.leaf,S.leafLight,S.leafDark][i]}/>)}
    <group position={[-24,-.35,7]}>
      <mesh rotation-x={-Math.PI/2} receiveShadow><circleGeometry args={[3.7,48]}/><meshPhysicalMaterial color={S.water} roughness={.2} metalness={.45} clearcoat={1}/></mesh>
      <mesh rotation-x={-Math.PI/2}><ringGeometry args={[3.7,4.05,48]}/><meshStandardMaterial color={S.waterEdge} roughness={.7}/></mesh>
      <mesh rotation-x={-Math.PI/2} position={[0,.018,0]}><ringGeometry args={[1.3,1.32,48]}/><meshBasicMaterial color={S.coolLight} transparent opacity={.22}/></mesh>
    </group>
    {specs.filter((_,i)=>i!==0&&i!==2).map(b=><Html key={b.name} position={[b.p[0],b.floors*1.05+(exploded?(b.floors-1)*.65:0)+.75,b.p[2]]} center zIndexRange={[2,0]} style={{pointerEvents:'none'}}><div className="building-label">{b.name}</div></Html>)}
  </group>;
});

/** Local PMREM environment: glass reflections work offline without HDR downloads. */
export function ArchitecturalLighting({revision}: {revision:string}) {
  const {gl,scene}=useThree();
  useEffect(()=>{
    const generator=new THREE.PMREMGenerator(gl),room=new RoomEnvironment();
    const target=generator.fromScene(room,.04);const previous=scene.environment;
    const previousIntensity=scene.environmentIntensity;
    scene.environment=target.texture;scene.environmentIntensity=.45;room.dispose();generator.dispose();
    return()=>{scene.environment=previous;scene.environmentIntensity=previousIntensity;target.dispose();};
  },[gl,scene]);
  useEffect(()=>{gl.shadowMap.needsUpdate=true;},[gl,revision]);
  return <>
    <ambientLight intensity={.2} color={S.ambient}/>
    <hemisphereLight args={[S.fill,S.ground,.65]}/>
    <directionalLight position={[-24,36,18]} intensity={1.9} color={S.sun} castShadow
      shadow-mapSize={[1024,1024]} shadow-camera-left={-43} shadow-camera-right={43}
      shadow-camera-top={37} shadow-camera-bottom={-37} shadow-camera-near={1} shadow-camera-far={110}
      shadow-normalBias={.05} shadow-bias={-.0002}/>
    <directionalLight position={[16,18,-28]} intensity={.65} color={S.fill}/>
    <mesh rotation-x={-Math.PI/2} position={[0,-1.44,0]}>
      <planeGeometry args={[1200,1200]}/><meshBasicMaterial color={S.sky}/>
    </mesh>
  </>;
}
