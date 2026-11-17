// First-person body: walks (and crouches) on the dry floors, swims in the
// drowned ones, and drifts free of gravity once it steps outside.
//
// Walking and falling follow Unreal's CharacterMovementComponent, as used by the reference game
// (PNH_Demo, UE5 First Person template): acceleration towards the input direction, ground friction
// that turns the velocity, braking deceleration plus braking friction when there is no input (in
// sub-steps), Unreal's jump impulse, gravity and air control. See camera.js for look and shakes.
import { WL, HALL, WET, VOID, TOP, BOT } from './gen.js';
import { FirstPersonCamera } from './camera.js';

export const EYE = 1.62, WALK = 0, SWIM = 1, FLY = 2;
const H_STAND = 1.75, H_CROUCH = 1.0, EYE_CROUCH = 0.86;

// Unreal units are centimetres; these are metres.
export const MOVE = {
  maxAcceleration: 20.48,          // MaxAcceleration 2048 (engine default)
  groundFriction: 8,               // GroundFriction (engine default)
  brakingWalking: 20.48,           // BrakingDecelerationWalking 2048 (engine default)
  brakingFrictionFactor: 2,        // BrakingFrictionFactor (engine default)
  brakingSubStep: 1 / 33,          // BrakingSubStepTime (engine default)
  brakingFalling: 15,              // BrakingDecelerationFalling 1500 (UE5 First Person template)
  airControl: 0.5,                 // AirControl (UE5 First Person template)
  airControlBoost: 2, airControlBoostSpeed: 0.25,   // AirControlBoostMultiplier / VelocityThreshold (engine defaults)
  gravity: 9.8,                    // GravityZ -980 x GravityScale 1
  jumpZ: 4.7,                      // a little above Unreal's 420, to clear this game's plinths
  jumpCost: 14,                    // breath spent on a jump                      // JumpZVelocity 420 (engine default)
  // The reference's MaxWalkSpeed sits in a compressed blueprint; these are this game's speeds,
  // which its creatures are balanced against (Unreal's default would be 6.0 m/s).
  walkSpeed: 3.3, runSpeed: 5.8, crouchSpeed: 1.7,
  stepHeight: 0.55,                // this game's floors step by up to 0.55 m
};

// UCharacterMovementComponent::ApplyVelocityBraking (horizontal)
function brake(b, dt, friction, decel) {
  if (b.vx === 0 && b.vz === 0) return;
  friction *= MOVE.brakingFrictionFactor;
  if (friction <= 0 && decel <= 0) return;
  const ox = b.vx, oz = b.vz, sp = Math.hypot(ox, oz);
  const rx = decel > 0 ? (-decel * ox) / sp : 0, rz = decel > 0 ? (-decel * oz) / sp : 0;
  const maxStep = Math.min(1 / 20, Math.max(1 / 75, MOVE.brakingSubStep));
  let rem = dt;
  while (rem >= 1e-6) {
    const step = rem > maxStep && friction > 0 ? Math.min(maxStep, rem * 0.5) : rem;
    rem -= step;
    b.vx += (-friction * b.vx + rx) * step;
    b.vz += (-friction * b.vz + rz) * step;
    if (b.vx * ox + b.vz * oz <= 0) { b.vx = b.vz = 0; return; }
  }
  const s2 = b.vx * b.vx + b.vz * b.vz;
  if (s2 <= 1e-8 || (decel > 0 && s2 <= 0.01)) b.vx = b.vz = 0;   // KINDA_SMALL_NUMBER, BRAKE_TO_STOP_VELOCITY 10 cm/s
}

// UCharacterMovementComponent::CalcVelocity (horizontal); (ax, az) is the acceleration in m/s^2
function calcVelocity(b, dt, friction, decel, maxSpeed, ax, az) {
  const zeroAcc = ax === 0 && az === 0;
  const over = (sp2, m) => sp2 > m * m * 1.01;
  const sp2 = b.vx * b.vx + b.vz * b.vz;
  if (zeroAcc || over(sp2, maxSpeed)) {
    const ox = b.vx, oz = b.vz;
    brake(b, dt, friction, decel);
    const n2 = b.vx * b.vx + b.vz * b.vz;
    if (over(sp2, maxSpeed) && n2 < maxSpeed * maxSpeed && ax * ox + az * oz > 0) {
      const ol = Math.hypot(ox, oz);
      b.vx = (ox / ol) * maxSpeed; b.vz = (oz / ol) * maxSpeed;
    }
  } else {
    const al = Math.hypot(ax, az), sp = Math.sqrt(sp2), k = Math.min(dt * friction, 1);
    b.vx -= (b.vx - (ax / al) * sp) * k;
    b.vz -= (b.vz - (az / al) * sp) * k;
  }
  if (!zeroAcc) {
    const cur2 = b.vx * b.vx + b.vz * b.vz;
    const maxIn = over(cur2, maxSpeed) ? Math.sqrt(cur2) : maxSpeed;
    b.vx += ax * dt; b.vz += az * dt;
    const l = Math.hypot(b.vx, b.vz);
    if (l > maxIn) { b.vx *= maxIn / l; b.vz *= maxIn / l; }
  }
}

export class Player {
  constructor(world, camera, sound) {
    this.world = world; this.camera = camera; this.sound = sound;
    this.view = new FirstPersonCamera(camera);
    this.x = 0; this.y = 0; this.z = 0; this.r = 0.32; this.h = H_STAND;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.mode = WALK; this.onGround = false; this.outside = false;
    this.crouched = false; this.eye = EYE; this.running = false;
    this.jumpBuf = 0; this.coyote = 0; this.winded = false;
    this.stamina = 100; this.tired = false; this.freeRun = 0;
    this.composure = 100; this.hurtT = 0; this.calm = 10;
    this.flash = false; this.battery = 100;
    this.stepOff = 0; this.stepAcc = 0; this.strokeT = 0;
    this.dist = 0;
    this.info = { realm: HALL, floor: 0, ceil: 3, solid: 0, R: null };
    this.ahead = { realm: HALL, floor: 0, ceil: 3, solid: 0, R: null };
  }

  get yaw() { return this.view.yaw; }
  set yaw(v) { this.view.yaw = v; }
  get pitch() { return this.view.pitch; }

  place(x, z, yaw = 0) {
    const info = this.world.cellInfo(x, z, this.info);
    this.x = x; this.z = z; this.y = (info.realm === VOID ? 0 : info.floor) + 0.02;
    this.vx = this.vy = this.vz = 0; this.view.yaw = yaw; this.view.pitch = 0; this.stepOff = 0;
    this.h = H_STAND; this.crouched = false;
  }

  dread(amount) { this.composure -= amount; this.calm = 0; }
  hit(amount) { this.composure -= amount; this.hurtT = 1; this.calm = 0; }

  update(dt, input, t) {
    const world = this.world, view = this.view;
    view.look(input.dx, input.dy);
    const sy = Math.sin(view.yaw), cy = Math.cos(view.yaw), sp = Math.sin(view.pitch), cp = Math.cos(view.pitch);

    const info = world.cellInfo(this.x, this.z, this.info);
    const sub = WL - this.y;
    const inWater = info.realm === WET && sub > 0;
    let mode;
    this.outside = info.realm === VOID || this.y >= TOP - 0.01 || this.y + this.h <= BOT + 0.01;
    if (this.outside) mode = FLY;
    else if (info.realm === WET && sub > (this.mode === SWIM ? 1.15 : 1.35)) mode = SWIM;
    else mode = WALK;
    if (mode !== this.mode) {
      if (mode === SWIM && this.vy < -3) this.sound.splash(0.5);
      this.mode = mode;
    }

    // crouching: hold to stay low; you only stand again where there is room
    const wantLow = input.crouch && mode === WALK;
    if (wantLow) { this.h = H_CROUCH; this.crouched = true; }
    else if (this.crouched && !world.collides(this.x, this.y, this.z, this.r, H_STAND)) { this.h = H_STAND; this.crouched = false; }

    const moving = input.f !== 0 || input.s !== 0;
    const sprint = input.sprint && moving && !this.tired && this.stamina > 0 && !this.crouched;
    this.running = sprint;
    this.freeRun = Math.max(0, this.freeRun - dt);
    if (sprint) { if (this.freeRun <= 0) this.stamina -= dt * (mode === FLY ? 9 : 20); if (this.stamina <= 0) this.tired = true; }
    else { this.stamina = Math.min(100, this.stamina + dt * 13); if (this.stamina > 30) this.tired = false; }

    // unstick if something put us inside geometry
    if (world.collides(this.x, this.y, this.z, this.r, this.h)) {
      let freed = false;
      for (let k = 1; k <= 12 && !freed; k++) {
        if (!world.collides(this.x, this.y + k * 0.1, this.z, this.r, this.h)) { this.y += k * 0.1; freed = true; }
      }
      if (!freed) { this.x += this.vx * dt; this.z += this.vz * dt; }
    }

    const x0 = this.x, y0 = this.y, z0 = this.z;
    let flags = 0, dyWant = 0;
    if (mode === WALK) {
      // AddMovementInput(forward, Y) + AddMovementInput(right, X), clamped to length 1, times MaxAcceleration
      let wx = -sy * input.f + cy * input.s, wz = -cy * input.f - sy * input.s;
      const wl = Math.hypot(wx, wz);
      if (wl > 1) { wx /= wl; wz /= wl; }
      let maxSpeed = this.crouched ? MOVE.crouchSpeed : sprint ? MOVE.runSpeed : MOVE.walkSpeed;
      if (inWater) maxSpeed *= Math.max(0.45, 1 - sub * 0.45);
      if (this.onGround) {
        calcVelocity(this, dt, MOVE.groundFriction, MOVE.brakingWalking, maxSpeed, wx * MOVE.maxAcceleration, wz * MOVE.maxAcceleration);
      } else {
        // falling: lateral acceleration scaled by air control (boosted when nearly still), no lateral friction
        let ac = MOVE.airControl;
        if (this.vx * this.vx + this.vz * this.vz < MOVE.airControlBoostSpeed ** 2) ac = Math.min(1, ac * MOVE.airControlBoost);
        calcVelocity(this, dt, 0, MOVE.brakingFalling, maxSpeed, wx * MOVE.maxAcceleration * ac, wz * MOVE.maxAcceleration * ac);
      }
      this.vy -= MOVE.gravity * dt;
      if (inWater && sub > 0.4) this.vy *= Math.exp(-2.5 * dt);
      // A press is remembered for a moment, and so is the ground: pressing slightly early, or just after
      // stepping off an edge, still jumps. A jump costs breath.
      if (input.jump) this.jumpBuf = 0.2;
      this.coyote = this.onGround ? 0.14 : Math.max(0, this.coyote - dt);
      if (this.jumpBuf > 0) {
        this.jumpBuf -= dt;
        if (this.coyote > 0 && !this.crouched) {
          if (this.stamina >= MOVE.jumpCost) {
            this.vy = Math.max(this.vy, MOVE.jumpZ); this.onGround = false;
            this.stamina -= MOVE.jumpCost;
          } else this.winded = true;
          this.coyote = 0; this.jumpBuf = 0;
        }
      }
      dyWant = this.vy * dt;
      flags = world.move(this, this.vx * dt, dyWant, this.vz * dt, inWater && sub > 0.3 ? 1.2 : this.onGround ? MOVE.stepHeight : 0.12);
      const was = this.onGround;
      this.onGround = (flags & 4) !== 0;
      if (this.onGround && !was && this.vy < -4.5) this.sound.step(inWater ? 'wade' : 'land', 0.9);
      if (flags & 4) this.vy = 0;
    } else {
      const ud = (input.up ? 1 : 0) - (input.down ? 1 : 0);
      let wx = -sy * cp * input.f + cy * input.s, wy = sp * input.f + ud, wz = -cy * cp * input.f - sy * input.s;
      const wl = Math.hypot(wx, wy, wz);
      if (wl > 1) { wx /= wl; wy /= wl; wz /= wl; }
      if (mode === SWIM) {
        const speed = sprint ? 4.1 : 2.5, k = 1 - Math.exp(-3.2 * dt);
        this.vx += (wx * speed - this.vx) * k; this.vy += (wy * speed - this.vy) * k; this.vz += (wz * speed - this.vz) * k;
        dyWant = this.vy * dt;
        const top = WL - 1.45;
        if (this.y + dyWant > top) { dyWant = top - this.y; if (this.vy > 0) this.vy = 0; }
        flags = world.move(this, this.vx * dt, dyWant, this.vz * dt, this.y > WL - 1.8 ? 2.05 : 0.6);
        if (wl > 0.1) { this.strokeT += dt * (sprint ? 1.6 : 1); if (this.strokeT > 1.5) { this.strokeT = 0; this.sound.step('swim', 0.5); } }
      } else {
        const speed = sprint ? 15 : 6.5, k = 1 - Math.exp(-1.5 * dt);
        this.vx += (wx * speed - this.vx) * k; this.vy += (wy * speed - this.vy) * k; this.vz += (wz * speed - this.vz) * k;
        if (Math.abs(this.y) > 140) this.vy -= Math.sign(this.y) * (Math.abs(this.y) - 140) * 0.5 * dt;
        dyWant = this.vy * dt;
        flags = world.move(this, this.vx * dt, dyWant, this.vz * dt, 0.6);
        if (flags & 3) {
          // nudge toward the opening when pushing against the edge of the structure
          const vl = Math.hypot(this.vx, this.vz) || 1;
          const a = world.cellInfo(this.x + (this.vx / vl) * 0.9 + (flags & 1 ? Math.sign(this.vx) * 0.5 : 0), this.z + (this.vz / vl) * 0.9 + (flags & 2 ? Math.sign(this.vz) * 0.5 : 0), this.ahead);
          if (a.realm !== VOID && !a.solid) {
            const ty = Math.max(a.floor + 0.03, Math.min(this.y, a.ceil - this.h - 0.03));
            if (Math.abs(ty - this.y) < 3) world.move(this, 0, Math.max(-4 * dt, Math.min(4 * dt, ty - this.y)), 0, 0);
          }
        }
      }
      this.onGround = false;
      if (flags & 4 && this.vy < 0) this.vy = 0;
    }
    if (flags & 1) this.vx = 0;
    if (flags & 2) this.vz = 0;
    if (flags & 8 && this.vy > 0) this.vy = 0;
    if (flags & 16) this.stepOff -= this.y - y0 - (mode === WALK ? 0 : dyWant);
    this.stepOff *= Math.exp(-11 * dt);

    // creatures and restless furniture are solid
    world.pushOut(this, mode !== WALK, 6 * dt);

    const moved = Math.hypot(this.x - x0, this.z - z0);
    this.dist += moved + (mode === WALK ? 0 : Math.abs(this.y - y0));
    if (mode === WALK && this.onGround) {
      this.stepAcc += moved;
      if (this.stepAcc > (sprint ? 2.3 : this.crouched ? 1.3 : 1.75)) {
        this.stepAcc = 0;
        this.sound.step(inWater ? 'wade' : info.realm === WET ? 'tile' : 'carpet', sprint ? 0.8 : this.crouched ? 0.2 : 0.5);
      }
    }

    // composure recovers when nothing has been near for a while
    this.calm += dt;
    if (this.calm > 4) this.composure = Math.min(100, this.composure + dt * 3.2);
    this.hurtT = Math.max(0, this.hurtT - dt * 1.4);

    // the torch runs down; a flat torch still gives a little
    if (this.flash) this.battery = Math.max(0, this.battery - dt * 0.6);

    // the blueprint's tick: Run while running, Walk while moving on the ground, otherwise Idle
    const hs = Math.hypot(this.vx, this.vz);
    if (mode === WALK && this.onGround && hs > 0.01) view.play(sprint ? 'run' : 'walk');
    else view.play('idle');

    this.eye += ((this.crouched ? EYE_CROUCH : EYE) - this.eye) * (1 - Math.exp(-12 * dt));
    const roll = mode === SWIM ? Math.sin(t * 0.8) * 0.02 : mode === FLY ? Math.sin(t * 0.23) * 0.04 : 0;
    view.apply(this.x, this.y + this.eye + this.stepOff, this.z, roll, dt);
  }
}
