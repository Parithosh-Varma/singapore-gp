/**
 * Stage 1 test environment: a flat, barrier-lined straight plus an open
 * skidpad. Stage 3 replaces this with the real Marina Bay circuit meshes.
 */
import * as THREE from 'three';

/** Layout constants for the test facility, in metres. */
const LAYOUT = {
  groundSize: 2400,
  roadWidth: 20,
  roadFromZ: -560,
  roadToZ: 240,
  barrierHalfThickness: 0.2,
  barrierHeight: 1.1,
  skidpadCenterZ: 420,
  skidpadRadius: 85,
};

export function buildTestTrack(physics, config) {
  const group = new THREE.Group();
  group.name = 'test-track';

  const ROAD_TOP = 0;
  const halfRoad = LAYOUT.roadWidth / 2;
  const roadLength = LAYOUT.roadToZ - LAYOUT.roadFromZ;
  const roadMidZ = (LAYOUT.roadToZ + LAYOUT.roadFromZ) / 2;

  const addGround = () => {
    // One big static slab; its top face is exactly y = 0.
    const half = LAYOUT.groundSize / 2;
    physics.addStaticBox(
      { x: half, y: 0.5, z: half },
      { x: 0, y: ROAD_TOP - 0.5, z: 0 },
      { friction: config.physics.groundFriction },
    );

    const mat = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.97 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(LAYOUT.groundSize, LAYOUT.groundSize), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  const addRoad = () => {
    // Slightly above the physics plane so the two never z-fight.
    const y = ROAD_TOP + 0.012;

    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(LAYOUT.roadWidth, roadLength),
      new THREE.MeshStandardMaterial({ color: 0x26282e, roughness: 0.92 }),
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, y, roadMidZ);
    road.receiveShadow = true;
    group.add(road);

    // Continuous edge lines.
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xdfe3ea });
    for (const sx of [-1, 1]) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(0.18, roadLength), lineMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(sx * (halfRoad - 0.7), y + 0.002, roadMidZ);
      group.add(line);
    }

    // Dashed centre line — instanced so it costs one draw call.
    const dashCount = Math.floor(roadLength / 12);
    const dash = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.16, 4),
      lineMat,
      dashCount,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const s = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < dashCount; i++) {
      m.compose(
        new THREE.Vector3(0, y + 0.002, LAYOUT.roadFromZ + 6 + i * 12),
        q,
        s,
      );
      dash.setMatrixAt(i, m);
    }
    dash.instanceMatrix.needsUpdate = true;
    group.add(dash);
  };

  const addSkidpad = () => {
    const y = ROAD_TOP + 0.012;
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(LAYOUT.skidpadRadius, 64),
      new THREE.MeshStandardMaterial({ color: 0x2a2d34, roughness: 0.94 }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(0, y, LAYOUT.skidpadCenterZ);
    pad.receiveShadow = true;
    group.add(pad);

    // Painted reference circles at 25 / 50 / 75 m radius.
    for (const r of [25, 50, 75]) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r - 0.12, r + 0.12, 96),
        new THREE.MeshBasicMaterial({ color: 0xb9c0cc, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0, y + 0.002, LAYOUT.skidpadCenterZ);
      group.add(ring);
    }
  };

  const addBarriers = () => {
    const t = LAYOUT.barrierHalfThickness;
    const h = LAYOUT.barrierHeight;
    const x = halfRoad + t;
    const y = ROAD_TOP + h / 2;

    // Physics: one long box per side. Cheap and gives clean sliding.
    for (const sx of [-1, 1]) {
      physics.addStaticBox(
        { x: t, y: h / 2, z: roadLength / 2 },
        { x: sx * x, y, z: roadMidZ },
        { friction: 0.35, restitution: 0.05 },
      );
    }

    // Visuals: instanced wall segments with alternating red/white caps.
    const segLen = 4;
    const count = Math.floor(roadLength / segLen);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xb6bcc6, roughness: 0.85 });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xd8232f, roughness: 0.7 });

    const walls = new THREE.InstancedMesh(
      new THREE.BoxGeometry(t * 2, h, segLen),
      wallMat,
      count * 2,
    );
    const caps = new THREE.InstancedMesh(
      new THREE.BoxGeometry(t * 2 + 0.03, 0.18, segLen),
      capMat,
      count * 2,
    );
    walls.castShadow = false;
    walls.receiveShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    let i = 0;
    for (const sx of [-1, 1]) {
      for (let k = 0; k < count; k++) {
        const z = LAYOUT.roadFromZ + segLen / 2 + k * segLen;
        m.compose(new THREE.Vector3(sx * x, y, z), q, s);
        walls.setMatrixAt(i, m);
        m.compose(new THREE.Vector3(sx * x, ROAD_TOP + h - 0.09, z), q, s);
        caps.setMatrixAt(i, m);
        i++;
      }
    }
    walls.instanceMatrix.needsUpdate = true;
    caps.instanceMatrix.needsUpdate = true;
    group.add(walls, caps);
  };

  const addMarkers = () => {
    // Purely decorative distance markers, kept off the racing line.
    const coneGeo = new THREE.ConeGeometry(0.28, 0.7, 12);
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a1f, roughness: 0.6 });

    const positions = [];
    for (let z = LAYOUT.roadFromZ + 40; z < LAYOUT.roadToZ; z += 80) {
      for (const sx of [-1, 1]) positions.push([sx * (halfRoad - 1.9), z]);
    }
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      const r = LAYOUT.skidpadRadius + 3;
      positions.push([Math.cos(a) * r, LAYOUT.skidpadCenterZ + Math.sin(a) * r]);
    }

    const cones = new THREE.InstancedMesh(coneGeo, coneMat, positions.length);
    cones.castShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    positions.forEach(([px, pz], i) => {
      m.compose(new THREE.Vector3(px, 0.35, pz), q, s);
      cones.setMatrixAt(i, m);
    });
    cones.instanceMatrix.needsUpdate = true;
    group.add(cones);
  };

  addGround();
  addRoad();
  addSkidpad();
  addBarriers();
  addMarkers();

  return {
    group,
    /** Authoritative grid slot for the car. Car faces +Z, i.e. yaw 0. */
    start: {
      position: { x: 0, y: config.chassisRestHeight + 0.02, z: LAYOUT.roadFromZ + 30 },
      yaw: 0,
    },
  };
}

/**
 * Vertical gradient skybox. Stage 5 swaps the palette for the Singapore
 * night look; the geometry stays.
 */
export function createSkybox({
  top = 0x0a1024,
  bottom = 0x2c3547,
  exponent = 0.75,
} = {}) {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(top) },
      uBottom: { value: new THREE.Color(bottom) },
      uExponent: { value: exponent },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uBottom;
      uniform float uExponent;
      varying vec3 vWorldPos;
      void main() {
        float h = normalize(vWorldPos).y;
        float t = pow(clamp(h * 0.5 + 0.5, 0.0, 1.0), uExponent);
        gl_FragColor = vec4(mix(uBottom, uTop, t), 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
  mesh.scale.setScalar(5000);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}
