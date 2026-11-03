import Phaser from "phaser";

const iso = (u: number, v: number) => ({ x: 495 + (u - v) * 48, y: 245 + (u + v) * 25 });
const GREEN = 0x7bffb2;
const drawDiamond = (g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, fill: number, stroke = 0x315d53) => {
  g.lineStyle(1, stroke, 0.8);
  g.fillStyle(fill, 1);
  g.beginPath(); g.moveTo(x, y - h); g.lineTo(x + w, y); g.lineTo(x, y + h); g.lineTo(x - w, y);
  g.closePath(); g.fillPath(); g.strokePath();
};

export function mountHeadquarters(element: HTMLElement, onSelect: (id: string) => void) {
  let selected = false;
  class Headquarters extends Phaser.Scene {
    constructor() { super("headquarters"); }
    create() {
      const bg = this.add.graphics();
      bg.fillGradientStyle(0x071517, 0x071517, 0x103b34, 0x0a2525);
      bg.fillRect(-200, -200, 1450, 1000);

      const glow = this.add.graphics();
      glow.fillStyle(0x1c8f62, .06);
      glow.fillEllipse(490, 390, 880, 420);

      const floor = this.add.graphics();
      // The room is a single large diamond; each tile has isometric coordinates.
      for (let u = 0; u < 8; u++) {
        for (let v = 0; v < 8; v++) {
          const p = iso(u, v);
          drawDiamond(floor, p.x, p.y, 48, 25, (u + v) % 2 ? 0x1b453d : 0x214b41);
        }
      }
      const border = this.add.graphics();
      border.lineStyle(4, 0x5ce7a5, .75);
      const corners = [iso(-.5,-.5),iso(7.5,-.5),iso(7.5,7.5),iso(-.5,7.5)];
      border.beginPath();
      border.moveTo(corners[0].x,corners[0].y);
      for(let i=1;i<corners.length;i++)border.lineTo(corners[i].x,corners[i].y);
      border.closePath(); border.strokePath();

      // Holographic command console, rendered as simple geometry, no external art needed.
      const p = iso(2.35, 2.1);
      const desk = this.add.graphics();
      drawDiamond(desk, p.x, p.y + 25, 88, 43, 0x123e36, 0x4bd79c);
      desk.fillStyle(0x0a2226); desk.fillRoundedRect(p.x-55,p.y-45,110,66,8);
      desk.lineStyle(3, GREEN,.85); desk.strokeRoundedRect(p.x-55,p.y-45,110,66,8);
      desk.lineStyle(1,0x85ffd0,.5); 
      for (let j=0;j<4;j++) desk.lineBetween(p.x-40,p.y-30+j*13,p.x+30-j*6,p.y-30+j*13);
      this.add.text(p.x,p.y-65,"MISSION CONSOLE",{fontFamily:"Arial",fontSize:"11px",color:"#a8ffd4"}).setOrigin(.5);
      this.tweens.add({targets:desk,alpha:{from:.8,to:1},duration:1900,yoyo:true,repeat:-1});

      const lights = this.add.graphics();
      for (const [u,v] of [[.2,.2],[7,.2],[.2,7],[7,7]]) {
        const q=iso(u,v);
        lights.fillStyle(0x2e9a70,.18); lights.fillCircle(q.x,q.y,25);
        lights.fillStyle(GREEN,.85); lights.fillCircle(q.x,q.y,5);
      }
      const npcPoint=iso(4.5,3.4);
      const npc = this.add.container(npcPoint.x,npcPoint.y);
      const body = this.add.graphics();
      body.fillStyle(0x001a14,.48); body.fillEllipse(0,7,48,18);
      body.fillStyle(0x083321); body.fillRoundedRect(-15,-53,30,51,9);
      body.fillStyle(0x36b978); body.fillRoundedRect(-13,-49,26,28,7);
      body.fillStyle(0x052821); body.fillRect(-12,-24,24,21);
      body.lineStyle(2,0x73f7af); body.strokeRoundedRect(-13,-49,26,28,7);
      body.fillStyle(0x9c7657); body.fillCircle(0,-66,12);
      body.fillStyle(0x141f21); body.fillEllipse(0,-75,23,11);
      body.fillStyle(0xb5ffd3); body.fillCircle(0,-37,4);
      npc.add(body);
      const ring = this.add.graphics();
      ring.lineStyle(2,GREEN,.85); ring.strokeCircle(0,0,31);
      ring.fillStyle(0x21c786,.18); ring.fillCircle(0,0,30);
      ring.y=-36; npc.addAt(ring,0);
      const marker = this.add.text(0,-104,"JOHN STEWART", {
        fontFamily:"Arial",fontSize:"12px",fontStyle:"bold",color:"#e0ffed",
        backgroundColor:"#123d38",padding:{x:8,y:5}
      }).setOrigin(.5);
      npc.add(marker);
      const prompt = this.add.text(0,-91,"● AVAILABLE",{fontFamily:"Arial",fontSize:"10px",color:"#7affba"}).setOrigin(.5);
      npc.add(prompt);
      this.tweens.add({targets:npc,y:npcPoint.y-5,duration:1600,yoyo:true,repeat:-1,ease:"Sine.easeInOut"});
      this.tweens.add({targets:ring,alpha:{from:.25,to:.9},duration:1300,yoyo:true,repeat:-1});
      const hit=this.add.zone(npcPoint.x,npcPoint.y-44,98,126).setInteractive({useHandCursor:true});
      hit.on("pointerover",()=>{marker.setColor("#68ffb0");});
      hit.on("pointerout",()=>{marker.setColor("#e0ffed");});
      hit.on("pointerdown",()=>{selected=true; ring.setVisible(true); onSelect("john");});
      this.add.text(495,46,"OA  /  CENTRAL COMMAND",{fontFamily:"Arial",fontSize:"15px",fontStyle:"bold",color:"#8af9b8"}).setOrigin(.5);
      this.add.text(495,68,"SECTOR 2814  ·  COMMAND SIMULATION",{fontFamily:"Arial",fontSize:"10px",color:"#6ba393"}).setOrigin(.5);
      this.cameras.main.setBounds(-150,-100,1290,930);
      this.cameras.main.setZoom(1);
      this.input.on("wheel",(_pointer: Phaser.Input.Pointer,_objects: unknown,_dx:number,dy:number)=>{
        const camera=this.cameras.main;
        camera.setZoom(Phaser.Math.Clamp(camera.zoom + (dy>0?-.08:.08),.65,1.55));
      });
      const cursors=this.input.keyboard?.createCursorKeys();
      const keys=this.input.keyboard?.addKeys("W,A,S,D") as Record<string,Phaser.Input.Keyboard.Key>|undefined;
      // Phaser captures keys globally by default, including keys typed in React forms.
      this.input.keyboard?.disableGlobalCapture();
      this.events.on("update",(_time:number,delta:number)=>{
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && (focused.matches("input, textarea, select") || focused.isContentEditable)) return;
        const camera=this.cameras.main; const movement=delta*.5/camera.zoom;
        if(cursors?.left.isDown||keys?.A?.isDown)camera.scrollX-=movement;
        if(cursors?.right.isDown||keys?.D?.isDown)camera.scrollX+=movement;
        if(cursors?.up.isDown||keys?.W?.isDown)camera.scrollY-=movement;
        if(cursors?.down.isDown||keys?.S?.isDown)camera.scrollY+=movement;
      });
      this.input.on("pointermove",(pointer:Phaser.Input.Pointer)=>{
        if(pointer.isDown && !selected && pointer.downElement===this.game.canvas) {
          this.cameras.main.scrollX -= (pointer.x-pointer.prevPosition.x)/this.cameras.main.zoom;
          this.cameras.main.scrollY -= (pointer.y-pointer.prevPosition.y)/this.cameras.main.zoom;
        }
      });
      const resetDrag = () => { selected = false; };
      window.addEventListener("pointerup", resetDrag);
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => window.removeEventListener("pointerup", resetDrag));
    }
  }
  const game = new Phaser.Game({
    type:Phaser.AUTO,
    parent:element,
    width:990,
    height:640,
    backgroundColor:"#06191a",
    scale:{mode:Phaser.Scale.FIT,autoCenter:Phaser.Scale.CENTER_BOTH},
    render:{pixelArt:false,antialias:true},
    scene:[Headquarters],
    audio:{noAudio:true}
  });
  return () => game.destroy(true);
}
