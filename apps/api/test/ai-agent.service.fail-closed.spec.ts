import { AIAgentService } from '../src/ai/ai-agent.service';
import type { InsightContext, AIInsight } from '../src/ai/ai.service';

/**
 * Regression test for the P1.5a fail-closed fix (Oct 2026 AI authorization audit):
 * isRecentlyRejected() used to swallow its own DB errors and return `false` ("not
 * rejected"), which meant a DB hiccup silently meant "allow auto-execution" instead
 * of "we don't know, so don't risk it". It now propagates the error, and process()'s
 * insight loop converts that into a normal skip (fail-closed) rather than letting it
 * escape — AIAgentService had zero existing tests before this commit.
 */
describe('AIAgentService.process — rejection-history check fail-closed', () => {
  function baseContext(): InsightContext {
    return {
      vehicleId: 'veh-1',
      userId: 'user-1',
      soc: 50,
      chargingState: null,
      vehicleState: 'parked',
      outsideTemp: 15,
      batteryRangeKm: 300,
      sohPercent: null,
      degradationPercent: null,
      estimatedCapacityKwh: null,
      nominalCapacityKwh: null,
      tripCount: 0,
      distanceKm: 0,
      energyKwh: 0,
      efficiencyWhKm: null,
      chargingSessions: 0,
      chargingEnergyKwh: 0,
      totalCost: null,
      costPerKm: null,
      vampireDrainPct: null,
      vampireDrainPerHr: null,
    };
  }

  function highPriorityCommandInsight(command: string): AIInsight {
    return {
      id: 'insight-1',
      severity: 'info',
      icon: 'bolt',
      title: `Do ${command}`,
      description: '',
      priority: 90, // >= 80, so process() considers it for auto-execution
      action: { type: 'command', command, label: command },
    };
  }

  function buildAgent(opts: { queryRawImpl: () => Promise<any> }) {
    const ai = { generateInsights: jest.fn().mockResolvedValue([highPriorityCommandInsight('door_lock')]) };
    const guard = { canExecute: jest.fn().mockReturnValue(true) };
    const executor = { execute: jest.fn().mockResolvedValue({ executed: true }) };
    const prisma = { $queryRaw: jest.fn().mockImplementation(opts.queryRawImpl) };
    const agent = new AIAgentService(ai as any, guard as any, executor as any, prisma as any);
    return { agent, executor, prisma };
  }

  it('DB error checking rejection history → insight is skipped, NOT executed', async () => {
    const { agent, executor } = buildAgent({
      queryRawImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    const result = await agent.process(baseContext(), 'auto');

    expect(result.executed).toEqual([]);
    expect(result.skipped).toEqual([
      { command: 'door_lock', reason: 'safety check unavailable: rejection history' },
    ]);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('confirmed NOT recently rejected → proceeds to executor as before (no regression)', async () => {
    const { agent, executor } = buildAgent({
      queryRawImpl: () => Promise.resolve([{ cnt: 0n }]),
    });

    const result = await agent.process(baseContext(), 'auto');

    expect(executor.execute).toHaveBeenCalledWith('veh-1', 'user-1', 'door_lock', 'auto');
    expect(result.executed).toEqual(['door_lock']);
  });

  it('confirmed recently rejected → skipped with the original reason (no regression)', async () => {
    const { agent, executor } = buildAgent({
      queryRawImpl: () => Promise.resolve([{ cnt: 1n }]),
    });

    const result = await agent.process(baseContext(), 'auto');

    expect(result.skipped).toEqual([{ command: 'door_lock', reason: 'recently rejected by user' }]);
    expect(executor.execute).not.toHaveBeenCalled();
  });
});
