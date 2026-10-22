// Lightweight 3D machine visualization. Scene coordinates are derived from the existing 2D layout.
// Three.js is loaded only when the operator opens 3D view, keeping the standard editor lightweight.
export async function createMachine3DView(container, statusEl) {
  const THREE = await import("https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js");
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x121d28);
  scene.fog = new THREE.Fog(0x121d28, 900, 2600);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 5000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.replaceChildren(renderer.domElement);
  const componentLabel = document.createElement('div');
  componentLabel.className = 'machine-3d-component-label';
  componentLabel.hidden = true;
  container.appendChild(componentLabel);
  scene.add(new THREE.HemisphereLight(0xc8e3ff, 0x27313a, 2.0));
  const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(-400, 700, 500); key.castShadow = true; scene.add(key);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({color:0x182630, roughness:.92}));
  floor.rotation.x = -Math.PI/2; floor.position.y = -4; floor.receiveShadow = true; scene.add(floor);
  const grid = new THREE.GridHelper(2400, 60, 0x3b5262, 0x293b49); grid.position.y = -2.8; scene.add(grid);
  const machineRoot = new THREE.Group(); scene.add(machineRoot);
  const meshes = new Map(); let currentState = {}; let selectedTag = null; let animationTime = 0;
  let transformHandlers = null; let transformTag = null; let transformOffset = null; let transformMoved = false;
  const mat = (color, metalness=.25, roughness=.55) => new THREE.MeshStandardMaterial({color, metalness, roughness});
  const steel=mat(0x8395a3,.72,.35), dark=mat(0x273744,.5,.45), blue=mat(0x2585c7,.35,.4), orange=mat(0xef9a35,.2,.5), green=mat(0x36b77b,.1,.45), red=mat(0xd84c4c,.1,.45), yellow=mat(0xe6c828,.1,.45);
  function canvasTex(draw,w,h){const c=document.createElement('canvas');c.width=w;c.height=h;draw(c.getContext('2d'),w,h);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=4;return t;}
  const cardboardTex=canvasTex((x,w,h)=>{x.fillStyle='#c79a5b';x.fillRect(0,0,w,h);for(let i=0;i<500;i++){x.fillStyle=`rgba(90,60,20,${Math.random()*.1})`;x.fillRect(Math.random()*w,Math.random()*h,3,1);}x.fillStyle='rgba(235,220,180,.9)';x.fillRect(0,h/2-9,w,18);x.strokeStyle='rgba(70,45,15,.6)';x.lineWidth=4;x.strokeRect(0,0,w,h);},128,128);
  const productMat=new THREE.MeshStandardMaterial({map:cardboardTex,roughness:.85,metalness:0});
  const beltTex=canvasTex((x,w,h)=>{x.fillStyle='#1d252b';x.fillRect(0,0,w,h);x.fillStyle='#2a343b';for(let i=0;i<w;i+=16)x.fillRect(i,0,4,h);},64,64);
  const belt=new THREE.MeshStandardMaterial({map:beltTex,roughness:.92,metalness:.05});
  const chrome=mat(0xdfe6ec,.95,.15), alu=mat(0x9fb2c2,.8,.3);
  const dimLampMats=[mat(0x592c2c,.1,.6),mat(0x29365b,.1,.6),mat(0x28513a,.1,.6),mat(0x5a5023,.1,.6)];
  function box(parent, size, material, pos) { const m=new THREE.Mesh(new THREE.BoxGeometry(...size),material); m.position.set(...pos); m.castShadow=true; m.receiveShadow=true; parent.add(m); return m; }
  function cylinder(parent, radius, length, material, pos, axis='x') { const m=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,length,20),material); if(axis==='x')m.rotation.z=Math.PI/2; if(axis==='z')m.rotation.x=Math.PI/2; m.position.set(...pos);m.castShadow=true;parent.add(m);return m; }
  function makeObject(tag,obj) {
    const g=new THREE.Group(); g.userData.tag=tag;
    const w=Math.max(18,Number(obj.width)||80), h=Math.max(12,Number(obj.height)||36), d=Math.max(22,h*.8);
    const type=obj.type;
    if(type==='conveyor') {
      // Slim fabricated side rails and feet read more like industrial equipment than a solid block.
      box(g,[w,7,5],steel,[0,6,-d/2+2.5]); box(g,[w,7,5],steel,[0,6,d/2-2.5]);
      for(const sx of [-1,1]) for(const sz of [-1,1]) {
        box(g,[6,13,6],dark,[sx*w*.39,-.5,sz*d*.31]);
        box(g,[12,2,10],steel,[sx*w*.39,-7.5,sz*d*.31]);
      }
      const bm=belt.clone();bm.map=beltTex.clone();bm.map.needsUpdate=true;bm.map.repeat.set(w/16,1);g.userData.beltMat=bm;box(g,[w-8,3,d-10],bm,[0,12,0]);
      box(g,[w,3,4],dark,[0,15,-d/2+2]); box(g,[w,3,4],dark,[0,15,d/2-2]);
      // Real conveyor rollers run across the belt (Z axis) and are spaced
      // along its travel direction (X). Their long axis is the cylinder's
      // local Y axis after the X rotation, so animation must spin locally
      // around that axis rather than overwriting world Euler Z.
      const rollerCount=Math.max(4,Math.min(32,Math.floor((w-12)/18)));
      const rollers=[];
      for(let i=0;i<rollerCount;i++){
        const x=-w/2+6+(w-12)*(i/(rollerCount-1));
        const roller=cylinder(g,2.1,Math.max(12,d-9),chrome,[x,9.9,0],'z');
        roller.userData.role='conveyor-roller';
        rollers.push(roller);
      }
      g.userData.rollers=rollers;
      const products=[]; for(let i=0;i<Math.min(8,(obj.box_positions||[]).length);i++) products.push(box(g,[Math.max(10,Number(obj.box_width)||22),Math.max(8,Number(obj.box_height)||14),Math.max(10,d*.55)],productMat,[0,22,0])); g.userData.products=products;
    } else if(type==='motor') {
      // Industrial IEC-style motor. Local X is the shaft axis (shaft points to +X).
      const cy=Math.max(15,h*.32), R=Math.max(9,Math.min(h*.3,d*.38));
      // mounting feet
      const footTop=cy-R+2;
      box(g,[w*.5,4,d*.75],dark,[-w*.08,2,0]);
      box(g,[w*.42,footTop-4,R*1.1],steel,[-w*.08,4+(footTop-4)/2,0]);
      for(const sz of [-1,1]) for(const sx of [-1,1]) cylinder(g,2,5,chrome,[-w*.08+sx*w*.2,5,sz*d*.3],'y');
      // main stator housing + cooling fins
      cylinder(g,R,w*.5,blue,[-w*.08,cy,0]);
      for(let i=0;i<8;i++) cylinder(g,R*1.07,1.6,mat(0x1d6fa8,.4,.4),[-w*.08-w*.22+i*(w*.44/7),cy,0]);
      // drive-end bell, rear end cap
      cylinder(g,R*1.1,w*.1,alu,[w*.2,cy,0]);
      cylinder(g,R*1.04,w*.1,dark,[-w*.38,cy,0]);
      // terminal box with lid on top
      box(g,[w*.2,R*.55,R*1.0],dark,[-w*.08,cy+R+R*.2,0]);
      box(g,[w*.17,2,R*.8],steel,[-w*.08,cy+R+R*.5,0]);
      // nameplate
      box(g,[w*.14,R*.5,.8],chrome,[w*.0,cy+R*.2,R*.99+.3]);
      // rotating shaft (with key) -- spins about its own X axis
      const shaftG=new THREE.Group(); shaftG.position.set(w*.25,cy,0); g.add(shaftG);
      cylinder(shaftG,Math.max(3,R*.3),w*.25,chrome,[w*.125,0,0]);
      box(shaftG,[w*.12,2,2],steel,[w*.14,Math.max(3,R*.3),0]);
      // rotating cooling fan at the rear
      const fanG=new THREE.Group(); fanG.position.set(-w*.46,cy,0); g.add(fanG);
      cylinder(fanG,R*.28,w*.06,steel,[0,0,0]);
      for(let i=0;i<6;i++){const p=new THREE.Group();p.rotation.x=i*Math.PI/3;fanG.add(p);box(p,[w*.035,R*.7,R*.35],orange,[0,R*.55,0]);}
      cylinder(g,R*.98,1.5,steel,[-w*.495,cy,0]);
      g.userData.rotor=shaftG; g.userData.shaft=fanG;
    } else if(type==='cylinder') {
      // Match CylinderBehavior._geometry(): local X points from the rear
      // cap toward the rod tip; the group origin is the footprint center.
      const cy=Math.max(12,h*.25), br=Math.max(8,h*.2), bl=w*.62, bx=-w*.19;
      cylinder(g,br,bl,alu,[bx,cy,0]);
      cylinder(g,br*1.15,Math.max(4,w*.055),dark,[bx-bl/2,cy,0]);
      const glandW=Math.max(7,w*.065);
      const rodMin=w*.62-glandW*.25;
      const rodMax=w-w*.025;
      const rodTravel=Math.max(1,rodMax-rodMin);
      const rodBaseX=rodMin-w/2;
      cylinder(g,br*1.15,glandW,dark,[w*.12,cy,0]);
      box(g,[bl*.8,3,br*1.6],dark,[bx,cy-br-1.5,0]);
      cylinder(g,2.5,5,steel,[bx-bl*.38,cy+br+2,0],'y');
      cylinder(g,2.5,5,steel,[bx+bl*.38,cy+br+2,0],'y');
      // The rod's exposed length grows from zero to the backend's full
      // rod travel. Its tip therefore follows the same normalized progress
      // and direction as the 2D renderer and physical model.
      const rod=cylinder(g,Math.max(3,br*.35),rodTravel,chrome,[rodBaseX,cy,0]);
      rod.userData.role='cylinder-rod'; rod.userData.maxTravel=rodTravel;
      rod.userData.baseX=rodBaseX; rod.userData.rodMin=rodMin; g.userData.rod=rod;
      const head=box(g,[Math.max(6,w*.05),br*1.2,br*1.2],orange,[rodBaseX,cy,0]);
      g.userData.cylinderHead=head; g.userData.rodTravel=rodTravel;
    } else if(type==='index_table') {
      cylinder(g,Math.max(14,w*.38),8,steel,[0,10,0],'y'); const tableTop=cylinder(g,Math.max(10,w*.29),5,blue,[0,16,0],'y'); g.userData.tableTop=tableTop;
      for(let i=0;i<4;i++){const a=i*Math.PI/2;box(g,[Math.max(8,w*.12),5,Math.max(8,w*.12)],orange,[Math.cos(a)*w*.24,21,Math.sin(a)*w*.24]);}
    } else if(type==='sensor') {
      // Inductive proximity sensor: threaded metallic barrel and sensing face.
      cylinder(g,Math.max(4,Math.min(w,h)*.27),Math.max(12,w*.7),alu,[0,12,0],'x');
      cylinder(g,Math.max(5,Math.min(w,h)*.31),4,dark,[w*.34,12,0],'x');
      cylinder(g,Math.max(4,Math.min(w,h)*.24),2,blue,[w*.4,12,0],'x');
      const range=new THREE.Mesh(new THREE.RingGeometry(.985,1,64),new THREE.MeshBasicMaterial({color:0x4ade80,transparent:true,opacity:.16,side:THREE.DoubleSide,depthWrite:false}));
      // The proximity field sits at the sensing face's height, following the
      // sensor's configured altitude with the rest of its component group.
      range.rotation.x=-Math.PI/2; range.position.y=12; range.raycast=()=>{}; g.add(range); g.userData.proximityRange=range;
      const sensorLight=cylinder(g,1.6,1.6,green,[0,20,0],'y'); sensorLight.userData.role='sensor-light'; g.userData.sensorLight=sensorLight;
    } else if(type==='photoelectric_sensor') {
      // Photoelectric emitter with a visible directional red beam.
      const sy=20;
      box(g,[8,2,8],steel,[0,4,0]);
      cylinder(g,1.6,sy-4,steel,[0,4+(sy-4)/2,0],'y');
      box(g,[w,7,Math.min(h*.8,12)],dark,[0,sy,0]);
      cylinder(g,1.5,.8,mat(0x0b2a4a,.9,.1),[w*.5+.4,sy,0],'x');
      const beamMat=new THREE.MeshBasicMaterial({color:0xff3b3b,transparent:true,opacity:.7,depthWrite:false});
      const beam=cylinder(g,.7,1,beamMat,[w*.4+.5,sy,0],'x'); beam.raycast=()=>{}; beam.castShadow=false; g.userData.sensorBeam=beam;
      const sensorLight=cylinder(g,1.6,1.6,green,[0,sy+4.3,0],'y'); sensorLight.userData.role='sensor-light'; g.userData.sensorLight=sensorLight;
    } else if(type==='tower_light') {
      cylinder(g,Math.max(5,w*.12),Math.max(10,h*.6),steel,[0,Math.max(8,h*.3),0],'y');
      // Give each lens its own vertical segment. Fixed 7-unit spacing caused
      // the lenses to overlap whenever the tower height exceeded ~54 units.
      const lampLength=Math.max(5,h*.08), lampGap=Math.max(1,h*.012);
      const lampSpacing=lampLength+lampGap, stackBottom=Math.max(12,h*.61);
      const lamps=[];
      [red,blue,green,yellow].forEach((m,i)=>{
        const y=stackBottom+lampLength/2+i*lampSpacing;
        const lamp=cylinder(g,Math.max(5,w*.14),lampLength,m,[0,y,0],'y');
        lamps.push(lamp);
      });
      g.userData.lamps=lamps;
    } else if(type==='push_button'||type==='emergency_push_button'||type==='toggle_switch') {
      box(g,[Math.max(20,w*.65),7,Math.max(20,d*.65)],dark,[0,4,0]); const actuator=cylinder(g,Math.max(6,w*.18),Math.max(8,h*.4),type==='emergency_push_button'?red:type==='toggle_switch'?steel:green,[0,Math.max(12,h*.35),0],'y'); actuator.userData.role='control-actuator'; g.userData.actuator=actuator;
    } else {
      box(g,[w,Math.max(8,h*.3),d],type==='label'?dark:steel,[0,Math.max(5,h*.15),0]);
    }
    const faultLamp= new THREE.Mesh(new THREE.SphereGeometry(Math.max(3,Math.min(w,h)*.07),12,8), red); faultLamp.position.set(w*.42,Math.max(12,h*.55),d*.42); faultLamp.visible=false; faultLamp.userData.role='fault-indicator'; g.add(faultLamp); g.userData.faultLamp=faultLamp;
    g.userData.dimensions={w,h,d}; return g;
  }
  function update(state) {
    currentState=state||{};
    for(const [tag,g] of meshes) if(!currentState[tag]) {machineRoot.remove(g);meshes.delete(tag);}
    const entries=Object.entries(currentState).filter(([,o])=>o&&o.type);
    for(const [tag,obj] of entries) {
      const w=Math.max(18,Number(obj.width)||80), h=Math.max(12,Number(obj.height)||36);
      let g=meshes.get(tag);
      const dim=g&&g.userData.dimensions;
      if(!g||g.userData.type!==obj.type||(tag!==transformTag&&dim&&(dim.w!==w||dim.h!==h))){if(g)machineRoot.remove(g);g=makeObject(tag,obj);g.userData.type=obj.type;meshes.set(tag,g);machineRoot.add(g);}
      if(tag!==transformTag) g.position.set((Number(obj.x)||0)+w/2,Number(obj.z)||0,(Number(obj.y)||0)+h/2);
      if(tag!==transformTag) g.rotation.y=-(Number(obj.rotation)||0)*Math.PI/180;
      if(obj.type==='conveyor') {
        if(g.userData.beltMat)g.userData.beltMat.map.offset.x=-(Number(obj.belt_phase)||0)/16;
        const pos=obj.box_positions||[], products=g.userData.products||(g.userData.products=[]); const travel=Math.max(1,w-(Number(obj.box_width)||22));
        while(products.length<pos.length) products.push(box(g,[Math.max(10,Number(obj.box_width)||22),Math.max(8,Number(obj.box_height)||14),Math.max(10,Math.max(22,h*.8)*.55)],productMat,[0,22,0]));
        products.forEach((p,i)=>{p.visible=i<pos.length;if(pos[i]!=null)p.position.x=-w/2+Math.min(travel,Math.max(0,pos[i]))+(Number(obj.box_width)||22)/2;});
        const rollerSpeed=(obj.running_status||obj.running)&&!obj.fault&&!obj.emergency_stop
          ? (Number(obj.speed)||0)*0.00012*(obj.direction_forward===false?-1:1) : 0;
        for(const roller of (g.userData.rollers||[])){
          // rotate around each roller's own cylinder axis; the axis is local Y
          // (mapped to world Z by the roller's initial X rotation).
          if(rollerSpeed) roller.rotateY(rollerSpeed);
        }
      }
      if(obj.type==='cylinder') {
        const rod=g.userData.rod,head=g.userData.cylinderHead;
        if(rod){
          const progress=Math.max(0,Math.min(1,Number(obj.progress ?? (obj.extended?1:0))));
          const travel=g.userData.rodTravel||rod.userData.maxTravel||0;
          const exposed=travel*progress;
          rod.scale.y=progress;
          rod.position.x=(rod.userData.baseX||0)+exposed/2;
          if(head)head.position.x=(rod.userData.baseX||0)+exposed+Math.max(3,w*.025);
        }
      }
      const active=!!(obj.running_status ?? obj.running) && !obj.fault && !obj.emergency_stop;
      if(g.userData.proximityRange){const radius=Math.max(0,Number(obj.detection_distance)||0);g.userData.proximityRange.scale.set(radius||.001,1,radius||.001);}
      if(g.userData.rotor){g.userData.spinRate=active?(obj.direction_forward===false?-1:1)*Math.min(Number(obj.speed)||0,1500)*.00002:0;}
      if(g.userData.sensorLight){const detected=!!obj.detected;g.userData.sensorLight.material=detected?green:steel;g.userData.sensorLight.scale.setScalar(detected?1.18:1);const bm=g.userData.sensorBeam;if(bm){const dist=Math.max(.01,Number(obj.detection_distance)||0),x0=w*.5+.5;bm.scale.y=dist;bm.position.x=x0+dist/2;}}
      if(g.userData.actuator){const pressed=!!(obj.pressed ?? obj.on);g.userData.actuator.position.y=Math.max(8,h*.35)-(pressed?3:0);if(obj.type==='toggle_switch')g.userData.actuator.rotation.z=pressed?-.45:.45;}
      if(g.userData.lamps){const lampKeys=['red','blue','green','yellow'];g.userData.lamps.forEach((lamp,i)=>{const on=!!obj[lampKeys[i]];lamp.material=on?[red,blue,green,yellow][i]:dimLampMats[i];});}
      if(g.userData.tableTop && obj.moving)g.userData.tableTop.rotation.y=animationTime*.0015;
      if(g.userData.faultLamp)g.userData.faultLamp.visible=!!(obj.fault||obj.emergency_stop);
      // Selection is used by toolbar actions, but must not alter the rendered
      // component. In particular, simulation and online clicks only open the
      // inspector; they must not visually enlarge or move machine objects.
      g.userData.tag=tag;
    }
    statusEl.textContent=`${entries.length} machine components · ${entries.filter(([,o])=>o.running).length} running · drag components to move in Design mode · drag empty space to orbit · scroll to zoom`;
    if(entries.length){const maxX=Math.max(...entries.map(([,o])=>(Number(o.x)||0)+(Number(o.width)||80))),maxY=Math.max(...entries.map(([,o])=>(Number(o.y)||0)+(Number(o.height)||36))); const centerX=maxX/2,centerZ=maxY/2; floor.position.set(centerX,-4,centerZ);grid.position.set(centerX,-2.8,centerZ);}
  }
  let target=new THREE.Vector3(300,0,200), radius=650, theta=Math.PI/4, phi=Math.PI/3;
  function placeCamera(){phi=Math.max(.18,Math.min(Math.PI/2-.05,phi));camera.position.set(target.x+radius*Math.sin(phi)*Math.cos(theta),target.y+radius*Math.cos(phi),target.z+radius*Math.sin(phi)*Math.sin(theta));camera.lookAt(target);}
  function resetCamera(){target.set(300,0,200);radius=650;theta=Math.PI/4;phi=Math.PI/3;placeCamera();}
  resetCamera();
  let dragging=false,lastX=0,lastY=0;
  renderer.domElement.style.touchAction='none';
  renderer.domElement.addEventListener('pointerdown',e=>{if(e.button!==0)return;
    const tag=pick(e.clientX,e.clientY);
    if(tag && transformHandlers?.canStart?.(tag,e)) {
      const g=meshes.get(tag), p=groundPoint(e.clientX,e.clientY);
      if(g&&p){
        transformTag=tag;transformOffset={x:g.position.x-p.x,z:g.position.z-p.z};transformMoved=false;dragging=false;
        renderer.domElement.style.cursor='grabbing';
        try { renderer.domElement.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();e.stopImmediatePropagation();return;
      }
    }
    dragging=true;lastX=e.clientX;lastY=e.clientY;
    try { renderer.domElement.setPointerCapture(e.pointerId); } catch (_) {}
  });
  window.addEventListener('pointermove',e=>{
    if(transformTag){if(!(e.buttons&1)){finishTransform();return;}const p=groundPoint(e.clientX,e.clientY),g=meshes.get(transformTag);if(!p||!g)return;
      const x=Math.round((p.x+transformOffset.x-g.userData.dimensions.w/2)/10)*10;
      const y=Math.round((p.z+transformOffset.z-g.userData.dimensions.h/2)/10)*10;
      g.position.x=x+g.userData.dimensions.w/2;g.position.z=y+g.userData.dimensions.h/2;transformMoved=true;transformHandlers?.move?.(transformTag,x,y);return;
    }
    if(!dragging)return;if(!(e.buttons&1)){dragging=false;return;}theta-=(e.clientX-lastX)*.008;phi+=(e.clientY-lastY)*.008;lastX=e.clientX;lastY=e.clientY;placeCamera();});
  window.addEventListener('pointerup',()=>{if(transformTag){finishTransform();return;}dragging=false;});
  window.addEventListener('pointercancel',()=>dragging=false);
  window.addEventListener('blur',()=>dragging=false);
  renderer.domElement.addEventListener('wheel',e=>{e.preventDefault();
    const rect=renderer.domElement.getBoundingClientRect();
    const ndc=new THREE.Vector2(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);
    const rc=new THREE.Raycaster(), plane=new THREE.Plane(new THREE.Vector3(0,1,0),0), p0=new THREE.Vector3(), p1=new THREE.Vector3();
    rc.setFromCamera(ndc,camera); const hit0=rc.ray.intersectPlane(plane,p0);
    radius=Math.max(120,Math.min(1800,radius*Math.exp(e.deltaY*.001))); placeCamera(); camera.updateMatrixWorld();
    rc.setFromCamera(ndc,camera); const hit1=rc.ray.intersectPlane(plane,p1);
    if(hit0&&hit1){target.x+=hit0.x-hit1.x;target.z+=hit0.z-hit1.z;placeCamera();}
  },{passive:false});
  function screenToLayout(clientX, clientY){
    const rect=renderer.domElement.getBoundingClientRect();
    const pointer=new THREE.Vector2(((clientX-rect.left)/rect.width)*2-1,-((clientY-rect.top)/rect.height)*2+1);
    const raycaster=new THREE.Raycaster(); raycaster.setFromCamera(pointer,camera);
    const ground=new THREE.Plane(new THREE.Vector3(0,1,0),0); const hit=new THREE.Vector3();
    if(!raycaster.ray.intersectPlane(ground,hit)) return null;
    return {x:Math.round(hit.x),y:Math.round(hit.z)};
  }
  function groundPoint(clientX,clientY){
    const rect=renderer.domElement.getBoundingClientRect();
    const pointer=new THREE.Vector2(((clientX-rect.left)/rect.width)*2-1,-((clientY-rect.top)/rect.height)*2+1);
    const raycaster=new THREE.Raycaster();raycaster.setFromCamera(pointer,camera);
    const hit=new THREE.Vector3();return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),hit)?hit:null;
  }
  function finishTransform(){
    if(!transformTag)return;const tag=transformTag,g=meshes.get(tag);if(g&&transformMoved)transformHandlers?.end?.(tag,Math.round((g.position.x-g.userData.dimensions.w/2)/10)*10,Math.round((g.position.z-g.userData.dimensions.h/2)/10)*10);
    transformTag=null;transformOffset=null;transformMoved=false;renderer.domElement.style.cursor='';
  }

  let onPick=null, onInteract=null, interactionTag=null, downX=0, downY=0;
  function pick(clientX,clientY){
    const rect=renderer.domElement.getBoundingClientRect();
    const p=new THREE.Vector2(((clientX-rect.left)/rect.width)*2-1,-((clientY-rect.top)/rect.height)*2+1);
    const rc=new THREE.Raycaster(); rc.setFromCamera(p,camera);
    const hit=rc.intersectObjects(machineRoot.children,true)[0];
    let o=hit&&hit.object; while(o&&!o.userData.tag) o=o.parent;
    return o?o.userData.tag:null;
  }
  renderer.domElement.addEventListener('pointerdown',e=>{downX=e.clientX;downY=e.clientY;interactionTag=pick(e.clientX,e.clientY);if(e.button===0&&interactionTag)onInteract?.(interactionTag,'down',e);});
  window.addEventListener('pointerup',e=>{if(interactionTag)onInteract?.(interactionTag,'up',e);interactionTag=null;});
  renderer.domElement.addEventListener('pointercancel',()=>{if(interactionTag)onInteract?.(interactionTag,'up',{});interactionTag=null;});
  renderer.domElement.addEventListener('click',e=>{if(Math.hypot(e.clientX-downX,e.clientY-downY)>4)return;onPick?.(pick(e.clientX,e.clientY),e);});

  function resize(){const w=Math.max(1,container.clientWidth),h=Math.max(1,container.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}
  const ro=new ResizeObserver(resize);ro.observe(container);resize();
  function updateComponentLabel(){
    const g=selectedTag&&meshes.get(selectedTag);
    if(!g||!currentState[selectedTag]){componentLabel.hidden=true;return;}
    const dim=g.userData.dimensions||{w:80,h:36};
    const anchor=new THREE.Vector3(g.position.x,g.position.y+Math.max(30,dim.h*.45),g.position.z).project(camera);
    if(anchor.z < -1 || anchor.z > 1){componentLabel.hidden=true;return;}
    componentLabel.textContent=selectedTag;
    componentLabel.style.left=`${(anchor.x+1)*container.clientWidth/2}px`;
    componentLabel.style.top=`${(1-anchor.y)*container.clientHeight/2}px`;
    componentLabel.hidden=false;
  }
  let raf=0;function loop(t=0){raf=requestAnimationFrame(loop);const dt=Math.min(50,t-animationTime);animationTime=t;for(const m of meshes.values()){const r=m.userData.spinRate;if(r){if(m.userData.rotor)m.userData.rotor.rotation.x+=r*dt;if(m.userData.shaft)m.userData.shaft.rotation.x+=r*dt;}}renderer.render(scene,camera);updateComponentLabel();}loop();
  return {update,resetCamera,screenToLayout,setSelectedTag(tag){selectedTag=tag||null;},setPickHandler(f){onPick=f;},setInteractionHandler(f){onInteract=f;},setTransformHandler(h){transformHandlers=h;},rotateSelected(degrees=90){const g=meshes.get(selectedTag);if(!g)return false;g.rotation.y-=degrees*Math.PI/180;return true;},destroy(){cancelAnimationFrame(raf);ro.disconnect();renderer.dispose();container.replaceChildren();}};
}
