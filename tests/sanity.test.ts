import { describe, expect, it } from 'vitest';
import { absorptionToDisplayHex, DRINK_MAP } from '../src/drinks';
import { FluidSimulation } from '../src/physics/fluidSim';
import { TRAY_SURFACE_Y } from '../src/types';

describe('Soda Fountain Core Sanity', () => {
  it('pours soda into the glass and updates fill ratio & Beer-Lambert optical color', () => {
    const sim = new FluidSimulation();
    // Move glass directly under Fanta nozzle (x = 370)
    expect(sim.beginGlassDrag(480, TRAY_SURFACE_Y + 80)).toBe(true);
    sim.updateGlassDrag(370, TRAY_SURFACE_Y + 80);
    sim.endGlassDrag();

    for (let i = 0; i < 30; i++) sim.step(1 / 60);

    sim.setDispensing('fanta', true);
    for (let i = 0; i < 120; i++) sim.step(1 / 60);
    sim.setDispensing('fanta', false);
    for (let i = 0; i < 45; i++) sim.step(1 / 60);

    const snap = sim.getSnapshot();
    expect(snap.mix.fillRatio).toBeGreaterThan(0.25);
    expect(snap.mix.recipeShares.fanta).toBeGreaterThan(0.95);

    // Mix Blue Raspberry into Fanta -> Beer-Lambert green dominant (not grey)
    expect(sim.beginGlassDrag(sim.getSnapshot().glass.x, TRAY_SURFACE_Y + 80)).toBe(true);
    sim.updateGlassDrag(DRINK_MAP['blue-raspberry'].nozzleX, TRAY_SURFACE_Y + 80);
    sim.endGlassDrag();
    for (let i = 0; i < 30; i++) sim.step(1 / 60);

    sim.setDispensing('blue-raspberry', true);
    for (let i = 0; i < 120; i++) sim.step(1 / 60);
    sim.setDispensing('blue-raspberry', false);
    for (let i = 0; i < 45; i++) sim.step(1 / 60);

    const mixed = sim.getSnapshot().mix;
    const hex = absorptionToDisplayHex(
      mixed.meanAbsorption[0],
      mixed.meanAbsorption[1],
      mixed.meanAbsorption[2]
    );
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // Orange + Cyan-Blue produces vibrant green (G channel clearly higher than R and B)
    expect(g).toBeGreaterThan(r + 25);
    expect(g).toBeGreaterThan(b + 25);
  });
});
