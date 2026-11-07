import { Canvas, useFrame } from '@react-three/fiber';
import { Grid, Html, Line, OrbitControls } from '@react-three/drei';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Health, LinkMode, NodeState } from './types';

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

function CampusBuilding({ spec, exploded, transparent }: { spec: BuildingSpec; exploded: boolean; transparent: boolean }) {
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
    <Html position={[0, spec.floors * (floorHeight + (exploded ? .65 : 0)) + .65, 0]} center distanceFactor={22} style={{ pointerEvents: 'none' }}>
      <div className="building-label">{spec.name}</div>
    </Html>
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

function Device({ node, health, selected, onSelect }: { node: NodeState; health: Health; selected: boolean; onSelect: () => void }) {
  const ref = useRef<THREE.Mesh>(null);
  const color = !node.online ? '#e5534b' : health === 'degraded' ? '#f1b84b' : '#42d38b';
  useFrame(({ clock }) => { if (ref.current) ref.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 3) * .07); });
  return <group position={positions[node.nodeId] ?? [0, 1, 0]} onClick={(event) => { event.stopPropagation(); onSelect(); }}>
    <mesh ref={ref} castShadow><octahedronGeometry args={[node.role === 'relay' ? .65 : .5]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={selected ? 1.7 : .65} /></mesh>
    <mesh rotation-x={-Math.PI / 2}><ringGeometry args={[.7, .78, 32]} /><meshBasicMaterial color={color} transparent opacity={.7} side={THREE.DoubleSide} /></mesh>
    <Html position={[0, .95, 0]} center distanceFactor={16} style={{ pointerEvents: 'none' }}><div className={`scene-label ${selected ? 'selected' : ''}`}><b>{node.nodeId}</b><span>{node.online ? (node.role === 'relay' ? '中继节点' : node.role === 'terminal' ? '业务终端' : '控制端') : '离线'}</span></div></Html>
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

function Campus({ nodes, mode, health, exploded, transparent, selected, onSelect }: SceneProps) {
  const trees = [[-24, -14], [-20, -14], [-8, -14], [8, -15], [21, -15], [25, -12], [-24, 16], [-20, 17], [9, 18], [18, 18], [25, 17], [-25, 1], [25, -2]];
  return <>
    <color attach="background" args={['#071019']} /><fog attach="fog" args={['#071019', 38, 82]} />
    <ambientLight intensity={.78} /><hemisphereLight args={['#d9eee4', '#1f2c27', 1.15]} />
    <directionalLight position={[18, 28, 16]} intensity={2.35} color="#f0f4e8" castShadow shadow-mapSize={[2048, 2048]} />
    <mesh rotation-x={-Math.PI / 2} position={[0, -.72, 0]} receiveShadow><planeGeometry args={[74, 60]} /><meshStandardMaterial color="#17231d" roughness={1} /></mesh>
    <Road position={[0, -.69, 0]} size={[4, 55]} /><Road position={[0, -.68, 0]} size={[62, 4]} />
    <Road position={[-14, -.68, 0]} size={[2.5, 42]} /><Road position={[14, -.68, 0]} size={[2.5, 42]} />
    {buildings.map((building) => <CampusBuilding key={building.name} spec={building} exploded={exploded} transparent={transparent} />)}
    {trees.map(([x, z], index) => <Tree key={index} position={[x, -.68, z]} />)}
    <ParkingLot />
    <mesh position={[-24, -.65, 7]} rotation-x={-Math.PI / 2}><circleGeometry args={[4.2, 48]} /><meshStandardMaterial color="#315f6d" roughness={.38} metalness={.08} /></mesh>
    <mesh position={[-24, -.61, 7]} rotation-x={-Math.PI / 2}><ringGeometry args={[4.25, 4.6, 48]} /><meshStandardMaterial color="#727d78" /></mesh>
    <Drone />
    {nodes.map((node) => <Device key={node.nodeId} node={node} health={health} selected={selected === node.nodeId} onSelect={() => onSelect(node.nodeId)} />)}
    <SignalRoute mode={mode} health={health} active={health !== 'offline' && health !== 'unknown'} />
    <Grid position={[0, -.7, 0]} args={[76, 62]} cellSize={1} cellThickness={.25} cellColor="#385046" sectionSize={5} sectionThickness={.75} sectionColor="#63786e" fadeDistance={58} />
    <OrbitControls makeDefault minDistance={24} maxDistance={68} maxPolarAngle={Math.PI / 2.04} target={[0, 2.5, 0]} />
  </>;
}

interface SceneProps {
  nodes: NodeState[]; mode: LinkMode; health: Health; exploded: boolean; transparent: boolean;
  selected: string; onSelect: (id: string) => void;
}

export function TwinScene(props: SceneProps) {
  return <Canvas shadows camera={{ position: [34, 28, 39], fov: 45 }} dpr={[1, 1.75]}><Campus {...props} /></Canvas>;
}
