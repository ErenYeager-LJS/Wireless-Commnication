import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import { advanceOrbit, FLIGHT_HEIGHT, flightAnchors, flightSignal, orbitPosition } from './flight-link';
import type { Health, ReceiverStatus } from './types';
import { SCENE as S } from './scene-theme';

type PointRef = {current: THREE.Vector3};

function RadioSegment({from, to, active, color}: {from: PointRef; to: PointRef; active: boolean; color: string}) {
  const segment = useRef<THREE.Mesh>(null);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const direction = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    if (!segment.current) return;
    direction.subVectors(to.current, from.current);
    segment.current.position.copy(from.current).add(to.current).multiplyScalar(.5);
    segment.current.scale.set(1, direction.length(), 1);
    segment.current.quaternion.setFromUnitVectors(up, direction.normalize());
  });
  return <mesh ref={segment} visible={active}><cylinderGeometry args={[.065, .065, 1, 8]} />
    <meshBasicMaterial color={color} transparent opacity={.85} /></mesh>;
}

function VideoPackets({points, active, color}: {points: PointRef[]; active: boolean; color: string}) {
  const dots = useRef<THREE.Mesh[]>([]);
  useFrame(({clock}) => {
    if (!active) return;
    const legs = points.length - 1;
    dots.current.forEach((dot, index) => {
      const t = ((clock.elapsedTime * .28 + index / 5) % 1) * legs;
      const leg = Math.min(legs - 1, Math.floor(t));
      dot.position.lerpVectors(points[leg].current, points[leg + 1].current, t - leg);
    });
  });
  return <group visible={active}>{Array.from({length: 5}, (_, i) => <mesh key={i} ref={m => {if (m) dots.current[i] = m;}}>
    <sphereGeometry args={[.2, 8, 8]} /><meshBasicMaterial color={color} />
  </mesh>)}</group>;
}

export function AirborneCamera({video, health, exploded, selected, onSelect}: {
  video?: ReceiverStatus | null; health: Health; exploded: boolean; selected: boolean; onSelect: () => void;
}) {
  const signal = flightSignal(video);
  const aircraft = useRef<THREE.Group>(null);
  const rotors = useRef<THREE.Group[]>([]);
  const label = useRef<HTMLDivElement>(null);
  const orbit = useRef({x: signal.center[0], z: signal.center[2], radius: signal.radius, angle: Math.PI});
  const source = useRef(new THREE.Vector3(...orbitPosition(orbit.current)));
  const guide = useRef<THREE.Mesh>(null);
  const anchors = flightAnchors(exploded);
  const relay = useRef(new THREE.Vector3(...anchors.relay)); relay.current.set(...anchors.relay);
  const receiver = useRef(new THREE.Vector3(...anchors.receiver)); receiver.current.set(...anchors.receiver);
  const color = signal.online ? health === 'degraded' ? S.amber : S.green : S.muted;
  const legs = signal.route === 'relay' ? [source, relay, receiver] : [source, receiver];
  useFrame((_, delta) => {
    if (signal.online) {
      orbit.current = advanceOrbit(orbit.current, signal, delta);
      source.current.set(...orbitPosition(orbit.current));
    }
    if (aircraft.current) {
      aircraft.current.position.copy(source.current);
      aircraft.current.rotation.y = -orbit.current.angle;
    }
    if (guide.current) {
      guide.current.position.set(orbit.current.x, FLIGHT_HEIGHT, orbit.current.z);
      guide.current.scale.setScalar(orbit.current.radius);
    }
    if (label.current) {
      label.current.dataset.position = JSON.stringify(source.current.toArray());
      label.current.dataset.radius = String(orbit.current.radius);
      label.current.dataset.angle = String(orbit.current.angle);
      label.current.dataset.center = JSON.stringify([orbit.current.x, orbit.current.z]);
    }
    rotors.current.forEach(rotor => {rotor.rotation.y += Math.min(delta, .1) * 24;});
  });
  return <>
    <mesh ref={guide} rotation-x={-Math.PI / 2} visible={signal.online}>
      <torusGeometry args={[1, .0025, 3, 96]} /><meshBasicMaterial color={color} transparent opacity={.28} />
    </mesh>
    {legs.slice(0, -1).map((p, i) => <RadioSegment key={i} from={p} to={legs[i + 1]} active={signal.online} color={color} />)}
    <VideoPackets points={legs} active={signal.online} color={color} />
    <group ref={aircraft} onClick={e => {e.stopPropagation(); onSelect();}}>
      <RoundedBox args={[1.65,.5,1.06]} radius={.18} smoothness={2}><meshStandardMaterial color={S.paper} metalness={.35} roughness={.32}/></RoundedBox>
      <RoundedBox args={[1.1,.11,.7]} radius={.05} smoothness={1} position={[0,.29,-.1]}><meshStandardMaterial color={S.carbon} metalness={.45} roughness={.4}/></RoundedBox>
      <mesh position={[0,-.43,.3]}><sphereGeometry args={[.28,16,10]}/><meshStandardMaterial color={S.carbon} metalness={.5} roughness={.3}/></mesh>
      <mesh position={[0,-.44,.55]} rotation-x={Math.PI/2}><cylinderGeometry args={[.16,.19,.18,16]}/><meshPhysicalMaterial color={S.lens} roughness={.08} metalness={.65} clearcoat={1}/></mesh>
      {[-1,1].map(side=><group key={side}>
        <mesh position={[side*.7,-.6,0]} rotation-z={side*.22}><boxGeometry args={[.07,.8,.07]}/><meshStandardMaterial color={S.carbon} roughness={.5}/></mesh>
        <RoundedBox args={[.1,.09,1.5]} radius={.04} smoothness={1} position={[side*.8,-.98,0]}><meshStandardMaterial color={S.carbon} roughness={.5}/></RoundedBox>
      </group>)}
      {([[1, 1], [1, -1], [-1, 1], [-1, -1]] as const).map(([x,z], i) => <group key={i}>
        <mesh position={[x, 0, z * .75]} rotation-y={x === z ? Math.PI / 4 : -Math.PI / 4}>
          <boxGeometry args={[1.8, .14, .16]} /><meshStandardMaterial color={S.carbon} metalness={.55} roughness={.4}/>
        </mesh>
        <mesh position={[x*1.55,.14,z*1.2]}><cylinderGeometry args={[.14,.16,.24,12]}/><meshStandardMaterial color={S.metal} metalness={.7} roughness={.25}/></mesh>
        <group ref={m=>{if(m)rotors.current[i]=m;}} position={[x*1.55,.28,z*1.2]}>
          <mesh><boxGeometry args={[1.65,.025,.12]}/><meshStandardMaterial color={S.carbon} metalness={.4} roughness={.4}/></mesh>
          <mesh><cylinderGeometry args={[.82,.82,.015,24]}/><meshBasicMaterial color={S.paper} transparent opacity={.12} depthWrite={false}/></mesh>
        </group>
        <mesh position={[x*1.55,.04,z*1.2]}><sphereGeometry args={[.075,8,6]}/><meshBasicMaterial color={z===1?S.green:S.red}/></mesh>
      </group>)}
      <mesh rotation-x={-Math.PI / 2} position={[0, -.7, 0]}>
        <ringGeometry args={[2, 2.08, 32]} /><meshBasicMaterial color={color} transparent opacity={selected ? .9 : .4} side={THREE.DoubleSide} />
      </mesh>
      <Html position={[0, 2, 0]} center zIndexRange={[4, 1]} style={{pointerEvents: 'none'}}>
        <div ref={label} className="flight-label" data-testid="aircraft-label" data-route={signal.route} data-online={signal.online} data-target-radius={signal.radius}>
          <b><span className="scene-full-name">UAV-01 · 图传无人机</span><span className="scene-short-name">无人机</span></b>
          <span><span className="scene-full-name">{signal.online ? `${signal.reference} ` : ''}</span>{signal.online ? `${signal.rssi ?? '—'} dBm` : '等待画面'}</span>
        </div>
      </Html>
    </group>
  </>;
}
