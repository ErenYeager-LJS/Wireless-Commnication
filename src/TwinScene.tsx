import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Grid, Html, Line, OrbitControls } from '@react-three/drei';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Health, LinkMode, NodeState, ReceiverStatus } from './types';
import { AirborneCamera } from './AirborneCamera';
import { FLIGHT_HEIGHT, flightAnchors, flightSignal } from './flight-link';
import { ArchitecturalLighting, CampusEnvironment } from './CampusEnvironment';
import { SCENE as S } from './scene-theme';

const INITIAL_CAMERA = {position: [34, 28, 39] as [number, number, number], fov: 45};
const LIVE_TARGET: [number, number, number] = [0, 4.5, 0];
const DEMO_TARGET: [number, number, number] = [0, 2.5, 0];

const positions: Record<string, [number, number, number]> = {
  'TERM-01': [-15, 1.1, 9], 'RELAY-01': [0, 8.2, -1], 'CONTROL-01': [15, 1.1, -9],
};

interface BuildingSpec {
  name: string; position: [number, number, number]; size: [number, number]; floors: number; color: string; accent: string;
}

const buildings: BuildingSpec[] = [
  { name: '综合指挥中心', position: [0, 0, -1], size: [10, 8], floors: 6, color: '#a9b7b0', accent: '#4cc38a' },
  { name: '通信研发中心', position: [-14, 0, -9], size: [9, 6], floors: 4, color: '#91a7b4', accent: '#57a6c8' },
  { name: '数据中心', position: [14, 0, -10], size: [8, 6], floors: 3, color: '#88958f', accent: '#d5aa57' },
  { name: '智能制造车间', position: [-15, 0, 10], size: [11, 7], floors: 2, color: '#9e9b91', accent: '#d1755f' },
  { name: '测试验证中心', position: [14, 0, 10], size: [10, 7], floors: 3, color: '#9aa7a0', accent: '#65b69a' },
  { name: '能源保障站', position: [0, 0, 14], size: [7, 5], floors: 2, color: '#8f9694', accent: '#d6bb58' },
];

function CampusBuilding({ spec, exploded, transparent, live }: { spec: BuildingSpec; exploded: boolean; transparent: boolean; live?: boolean }) {
  const floorHeight = 1.05;
  return <group position={spec.position}>
    {Array.from({ length: spec.floors }, (_, floor) => {
      const gap = exploded ? .65 : 0;
      const y = floor * (floorHeight + gap) + floorHeight / 2;
      return <group key={floor} position={[0, y, 0]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[spec.size[0], floorHeight - .08, spec.size[1]]} />
          <meshPhysicalMaterial color={spec.color} transparent opacity={transparent ? .16 : .78}
            transmission={transparent ? .35 : 0} roughness={.62} metalness={.08} />
        </mesh>
        <mesh position={[0, -.49, 0]}>
          <boxGeometry args={[spec.size[0] + .18, .12, spec.size[1] + .18]} />
          <meshStandardMaterial color={floor === 0 ? spec.accent : '#d1dad5'} transparent opacity={transparent ? .24 : .82} />
        </mesh>
        {[-1, 1].map((side) => <mesh key={side} position={[side * (spec.size[0] / 2 + .01), 0, 0]}>
          <boxGeometry args={[.04, .42, spec.size[1] * .68]} /><meshBasicMaterial color={spec.accent} transparent opacity={.72} />
        </mesh>)}
      </group>;
    })}
    <mesh position={[0, -.35, 0]} receiveShadow><boxGeometry args={[spec.size[0] + .8, .7, spec.size[1] + .8]} /><meshStandardMaterial color="#2b3430" roughness={.9} /></mesh>
    {!(live && (spec.name === '综合指挥中心' || spec.name === '数据中心')) && <Html position={[0, spec.floors * (floorHeight + (exploded ? .65 : 0)) + .65, 0]} center zIndexRange={[2, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`building-label ${live && (spec.name === '综合指挥中心' || spec.name === '数据中心') ? 'link-building-label' : ''}`}>
        {live && spec.name === '综合指挥中心' ? '中继站 · 中间综合楼' : live && spec.name === '数据中心' ? '接收中心 · 右侧数据楼' : spec.name}
      </div>
    </Html>}
  </group>;
}

function Road({ position, size }: { position: [number, number, number]; size: [number, number] }) {
  const laneMark: [number, number] = size[0] > size[1] ? [size[0] * .92, .08] : [.08, size[1] * .92];
  return <group position={position}>
    <mesh rotation-x={-Math.PI / 2} receiveShadow><planeGeometry args={size} /><meshStandardMaterial color="#303638" roughness={.94} /></mesh>
    <mesh position={[0, .012, 0]} rotation-x={-Math.PI / 2}><planeGeometry args={laneMark} /><meshBasicMaterial color="#d8c66a" transparent opacity={.65} /></mesh>
  </group>;
}

function Tree({ position }: { position: [number, number, number] }) {
  return <group position={position}>
    <mesh position={[0, .55, 0]} castShadow><cylinderGeometry args={[.1, .14, 1.1, 8]} /><meshStandardMaterial color="#765f43" /></mesh>
    <mesh position={[0, 1.4, 0]} castShadow><coneGeometry args={[.62, 1.5, 9]} /><meshStandardMaterial color="#3d7657" roughness={.9} /></mesh>
  </group>;
}

function ParkingLot() {
  return <group position={[22, .03, 7]}>
    <mesh rotation-x={-Math.PI / 2} receiveShadow><planeGeometry args={[8, 11]} /><meshStandardMaterial color="#454b49" /></mesh>
    {[-3, -1, 1, 3].map((x) => <Line key={x} points={[[x, .03, -4.8], [x, .03, 4.8]]} color="#b8c2bd" lineWidth={1} transparent opacity={.45} />)}
    {[[-2.2, 0, -3], [1.8, 0, 3], [-2.2, 0, 2]].map((position, index) => <mesh key={index} position={position as [number, number, number]} castShadow>
      <boxGeometry args={[1.2, .55, 2.2]} /><meshStandardMaterial color={['#c75b53', '#c6a758', '#7798a8'][index]} metalness={.3} roughness={.5} />
    </mesh>)}
  </group>;
}

function Drone() {
  const drone = useRef<THREE.Group>(null);
  const rotors = useRef<THREE.Mesh[]>([]);
  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime * .13;
    if (drone.current) {
      drone.current.position.set(Math.cos(t) * 21, 9 + Math.sin(t * 2) * 1.2, Math.sin(t) * 16);
      drone.current.rotation.y = -t + Math.PI / 2;
    }
    rotors.current.forEach((rotor) => { rotor.rotation.y += delta * 24; });
  });
  const arms: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const patrolPath = Array.from({ length: 65 }, (_, index) => {
    const angle = index / 64 * Math.PI * 2;
    return [Math.cos(angle) * 21, 9, Math.sin(angle) * 16] as [number, number, number];
  });
  return <>
    <Line points={patrolPath} color="#85bca6" lineWidth={1} dashed dashSize={.35} gapSize={.35} transparent opacity={.26} />
    <group ref={drone}>
      <mesh castShadow><boxGeometry args={[1.2, .34, .82]} /><meshStandardMaterial color="#d8dfdb" metalness={.5} roughness={.35} /></mesh>
      <mesh position={[0, -.28, .16]} rotation-x={Math.PI / 2}><coneGeometry args={[.19, .42, 12]} /><meshStandardMaterial color="#25322d" /></mesh>
      <pointLight position={[0, -.42, .1]} color="#67e2a6" intensity={1.7} distance={5} />
      {arms.map(([x, z], index) => <group key={index}>
        <mesh position={[x * .72, 0, z * .58]} rotation-y={x === z ? Math.PI / 4 : -Math.PI / 4}>
          <boxGeometry args={[1.35, .09, .09]} /><meshStandardMaterial color="#5e6a65" metalness={.55} />
        </mesh>
        <mesh ref={(element) => { if (element) rotors.current[index] = element; }} position={[x * 1.16, .11, z * .92]}>
          <cylinderGeometry args={[.63, .63, .025, 20]} /><meshBasicMaterial color="#b9cbc3" transparent opacity={.38} />
        </mesh>
      </group>)}
      <Html position={[0, 1.1, 0]} center distanceFactor={18} style={{ pointerEvents: 'none' }}><div className="drone-label"><b>UAV-01</b><span>园区巡逻中</span></div></Html>
    </group>
  </>;
}

function Device({ node, health, selected, onSelect, position, live }: { node: NodeState; health: Health; selected: boolean; onSelect: () => void; position?: [number, number, number]; live?: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  const color = !node.online ? S.red : health === 'degraded' ? S.amber : S.green;
  useFrame(({ clock }) => { if (ref.current) ref.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 3) * .07); });
  return <group position={position ?? positions[node.nodeId] ?? [0, 1, 0]} onClick={(event) => { event.stopPropagation(); onSelect(); }}>
    {live ? <>
      <mesh position={[0,-1.05,0]}><boxGeometry args={[1.4,.32,1.2]}/><meshStandardMaterial color={S.paper} roughness={.5} metalness={.35}/></mesh>
      <mesh position={[0,-.25,0]}><cylinderGeometry args={[.06,.09,1.5,10]}/><meshStandardMaterial color={S.metal} metalness={.75} roughness={.3}/></mesh>
      {[-1,1].map(side=><mesh key={side} position={[side*.42,.12,0]} rotation-z={side*.13}>
        <boxGeometry args={[.16,.85,.24]}/><meshStandardMaterial color={S.paper} roughness={.4}/>
      </mesh>)}
      <mesh ref={ref} position={[0,.56,0]}><sphereGeometry args={[.12,12,8]}/><meshBasicMaterial color={color}/></mesh>
    </> : <mesh ref={ref} castShadow><octahedronGeometry args={[node.role === 'relay' ? .65 : .5]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={selected ? 1.7 : .65} /></mesh>}
    <mesh rotation-x={-Math.PI / 2}><ringGeometry args={[.7, .78, 32]} /><meshBasicMaterial color={color} transparent opacity={.7} side={THREE.DoubleSide} /></mesh>
    <Html position={[0, 1.35, 0]} center zIndexRange={[3, 0]} style={{ pointerEvents: 'none' }}><div className={`scene-label ${selected ? 'selected' : ''}`} data-node-id={node.nodeId}>
      <b>{live ? <><span className="scene-full-name">{node.role === 'relay' ? '中继站 · 综合楼' : '接收中心 · 数据楼'}</span><span className="scene-short-name">{node.role === 'relay' ? '中继站' : '接收中心'}</span></> : node.nodeId}</b>
      <span className="scene-node-detail">{live && node.role === 'relay' ? node.online ? '正在转发图像' : '等待中继路径' : node.online ? live ? '路由器 / 控制电脑' : (node.role === 'relay' ? '中继节点' : node.role === 'terminal' ? '业务终端' : '控制端') : '离线'}</span>
    </div></Html>
  </group>;
}

function FlowDots({ points, color }: { points: [number, number, number][]; color: string }) {
  const refs = useRef<THREE.Mesh[]>([]);
  const curve = useMemo(() => new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point))), [points]);
  useFrame(({ clock }) => refs.current.forEach((mesh, index) => mesh.position.copy(curve.getPoint((clock.elapsedTime * .22 + index / 5) % 1))));
  return <>{Array.from({ length: 5 }, (_, index) => <mesh key={index} ref={(element) => { if (element) refs.current[index] = element; }}><sphereGeometry args={[.13, 10, 10]} /><meshBasicMaterial color={color} /></mesh>)}</>;
}

function SignalRoute({ mode, health, active }: { mode: LinkMode; health: Health; active: boolean }) {
  const color = health === 'offline' ? '#e5534b' : health === 'degraded' ? '#f1b84b' : '#42d38b';
  const ids = mode === 'relay' ? ['TERM-01', 'RELAY-01', 'CONTROL-01'] : ['TERM-01', 'CONTROL-01'];
  const points = ids.map((id) => positions[id]);
  return <><Line points={points} color={color} lineWidth={active ? 5 : 2} dashed={!active} dashSize={.35} gapSize={.2} transparent opacity={active ? .95 : .35} />{active && <FlowDots points={points} color={color} />}</>;
}

function Campus({ nodes, mode, health, exploded, transparent, selected, onSelect, videoPriority, video }: SceneProps) {
  const trees = [[-24, -14], [-20, -14], [-8, -14], [8, -15], [21, -15], [25, -12], [-24, 16], [-20, 17], [9, 18], [18, 18], [25, 17], [-25, 1], [25, -2]];
  const anchors = flightAnchors(exploded);
  return <>
    <color attach="background" args={[videoPriority ? S.sky : '#071019']} /><fog attach="fog" args={videoPriority ? [S.sky, 180, 650] : ['#071019', 38, 82]} />
    {videoPriority ? <><ArchitecturalLighting revision={`${exploded}:${transparent}`}/><CampusEnvironment exploded={exploded} transparent={transparent}/></> : <>
    <ambientLight intensity={.78} /><hemisphereLight args={['#d9eee4', '#1f2c27', 1.15]} />
    <directionalLight position={[18, 28, 16]} intensity={2.35} color="#f0f4e8" castShadow shadow-mapSize={videoPriority ? [1024, 1024] : [2048, 2048]} />
    <mesh rotation-x={-Math.PI / 2} position={[0, -.72, 0]} receiveShadow><planeGeometry args={[74, 60]} /><meshStandardMaterial color="#17231d" roughness={1} /></mesh>
    <Road position={[0, -.69, 0]} size={[4, 55]} /><Road position={[0, -.68, 0]} size={[62, 4]} />
    <Road position={[-14, -.68, 0]} size={[2.5, 42]} /><Road position={[14, -.68, 0]} size={[2.5, 42]} />
    {buildings.map((building) => <CampusBuilding key={building.name} spec={building} exploded={exploded} transparent={transparent} live={videoPriority} />)}
    {trees.map(([x, z], index) => <Tree key={index} position={[x, -.68, z]} />)}
    <ParkingLot />
    <mesh position={[-24, -.65, 7]} rotation-x={-Math.PI / 2}><circleGeometry args={[4.2, 48]} /><meshStandardMaterial color="#315f6d" roughness={.38} metalness={.08} /></mesh>
    <mesh position={[-24, -.61, 7]} rotation-x={-Math.PI / 2}><ringGeometry args={[4.25, 4.6, 48]} /><meshStandardMaterial color="#727d78" /></mesh>
    </>}
    {videoPriority ? <>
      <AirborneCamera video={video} health={health} exploded={exploded} selected={selected === 'TERM-01'} onSelect={() => onSelect('TERM-01')} />
      {nodes.filter(node => node.role !== 'terminal').map(node => <Device key={node.nodeId} node={node} health={health} live
        position={node.role === 'relay' ? anchors.relay : anchors.receiver} selected={selected === node.nodeId} onSelect={() => onSelect(node.nodeId)} />)}
    </> : <>
      <Drone />
      {nodes.map((node) => <Device key={node.nodeId} node={node} health={health} selected={selected === node.nodeId} onSelect={() => onSelect(node.nodeId)} />)}
      <SignalRoute mode={mode} health={health} active={health !== 'offline' && health !== 'unknown'} />
    </>}
    {!videoPriority && <Grid position={[0, -.7, 0]} args={[76, 62]} cellSize={1} cellThickness={.25} cellColor="#385046" sectionSize={5} sectionThickness={.75} sectionColor="#63786e" fadeDistance={58} />}
    <OrbitControls makeDefault minDistance={24} maxDistance={videoPriority ? 360 : 68} maxPolarAngle={Math.PI / 2.04} target={videoPriority ? LIVE_TARGET : DEMO_TARGET} />
  </>;
}

interface SceneProps {
  nodes: NodeState[]; mode: LinkMode; health: Health; exploded: boolean; transparent: boolean;
  selected: string; onSelect: (id: string) => void; videoPriority?: boolean; video?: ReceiverStatus | null;
}

function VideoPriorityFrames() {
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => {
    // The campus is illustrative: reserve CPU/GPU time for 720p video and inference.
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame: number;
    const tick = () => {
      if (!document.hidden && !reduced.matches && !document.querySelector('.esp-camera-modal[open]')) invalidate();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [invalidate]);
  return null;
}

function SceneRenderInfo({onDpr}: {onDpr:(value:number)=>void}) {
  const last = useRef(0);
  const gl = useThree(s=>s.gl);
  const software = useRef(false);
  const slowFrames = useRef(0);
  useEffect(()=>{
    const context=gl.getContext();
    const debug=context.getExtension('WEBGL_debug_renderer_info');
    const name=String(debug?context.getParameter(debug.UNMASKED_RENDERER_WEBGL):context.getParameter(context.RENDERER));
    software.current=/swiftshader|llvmpipe|software|basic render/i.test(name);
    gl.domElement.dataset.renderer=name;
    onDpr(software.current ? .55 : Math.min(devicePixelRatio,1.25));
  },[gl,onDpr]);
  useFrame(({gl,clock},delta)=>{
    if(delta>.05)slowFrames.current++;else slowFrames.current=Math.max(0,slowFrames.current-1);
    if(slowFrames.current>40){
      const next=Math.max(software.current?.45:.65,gl.getPixelRatio()*.85);
      if(next<gl.getPixelRatio()-.01)onDpr(next);
      slowFrames.current=0;
    }
    if(clock.elapsedTime-last.current<1)return;
    last.current=clock.elapsedTime;
    gl.domElement.dataset.sceneDrawCalls=String(gl.info.render.calls);
    gl.domElement.dataset.sceneTriangles=String(gl.info.render.triangles);
    gl.domElement.dataset.sceneTextures=String(gl.info.memory.textures);
    gl.domElement.dataset.shadowUpdates=String(gl.shadowMap.autoUpdate);
    gl.domElement.dataset.sceneDpr=String(gl.getPixelRatio());
  });
  return null;
}

function FitFlightView({video}: {video?: ReceiverStatus | null}) {
  const {camera, size} = useThree();
  const destination = useRef<THREE.Vector3 | null>(null);
  const viewport = useRef('');
  const signal = flightSignal(video);
  const radiusBand = Math.ceil(signal.radius / 5) * 5;
  const route = signal.route;
  useEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const candidate = camera.clone();
    const target = new THREE.Vector3(...LIVE_TARGET);
    const angle = viewport.current ? camera.position.clone().sub(target).normalize() : new THREE.Vector3(34, 28, 39).normalize();
    const center = route === 'relay' ? flightAnchors().relay : flightAnchors().receiver;
    const bounds = [[-34, -.4, 26], [34, -.4, 26], [-34, -.4, -26], [34, -.4, -26], [0, 10, -1], [14, 6, -10],
      ...Array.from({length: 16}, (_, i) => [center[0] + Math.cos(i * Math.PI / 8) * radiusBand,
        FLIGHT_HEIGHT + 3, center[2] + Math.sin(i * Math.PI / 8) * radiusBand])];
    const margin = size.width < 450 ? 58 : 100;
    const maxX = Math.max(.25, 1 - margin * 2 / size.width);
    for (let distance = 55; distance <= 360; distance *= 1.08) {
      candidate.position.copy(target).addScaledVector(angle, distance);
      candidate.lookAt(target); candidate.updateMatrixWorld();
      if (bounds.every((p,index) => {
        const screen = new THREE.Vector3(...p).project(candidate);
        const terrain=index<4;
        return Math.abs(screen.x) <= (terrain ? .95 : maxX) && screen.y < .68 && screen.y > (terrain ? -.95 : -.55);
      })) break;
    }
    const key = `${size.width}:${size.height}`;
    if (viewport.current !== key) {
      camera.position.copy(candidate.position);
      camera.lookAt(target); camera.updateMatrixWorld();
      destination.current = null;
    } else destination.current = candidate.position.clone();
    viewport.current = key;
  }, [camera, size.width, size.height, radiusBand, route]);
  useFrame((_, delta) => {
    if (!destination.current) return;
    camera.position.lerp(destination.current, 1 - Math.exp(-Math.min(delta, .1) * 5));
    if (camera.position.distanceToSquared(destination.current) < .0001) destination.current = null;
  });
  return null;
}

export const TwinScene = memo(function TwinScene(props: SceneProps) {
  const [pixelRatio,setPixelRatio]=useState(1);
  return <Canvas shadows camera={INITIAL_CAMERA} dpr={props.videoPriority ? pixelRatio : [1, 1.75]}
    gl={{antialias:true, toneMapping:THREE.ACESFilmicToneMapping, toneMappingExposure:1.05}}
    onCreated={({gl})=>{if(props.videoPriority){gl.shadowMap.autoUpdate=false;gl.shadowMap.needsUpdate=true;}}}
    frameloop={props.videoPriority ? 'demand' : 'always'}>
    {props.videoPriority && <><FitFlightView video={props.video} /><VideoPriorityFrames /><SceneRenderInfo onDpr={setPixelRatio}/></>}<Campus {...props} />
  </Canvas>;
}, (a, b) => a.mode === b.mode && a.health === b.health && a.exploded === b.exploded &&
  a.transparent === b.transparent && a.selected === b.selected && a.onSelect === b.onSelect && a.videoPriority === b.videoPriority &&
  a.video?.online === b.video?.online && a.video?.enabled === b.video?.enabled && a.video?.rssi === b.video?.rssi && a.video?.route === b.video?.route &&
  a.nodes.length === b.nodes.length && a.nodes.every((n, i) => {
    const other = b.nodes[i];
    return n.nodeId === other.nodeId && n.role === other.role && n.online === other.online;
  }));
