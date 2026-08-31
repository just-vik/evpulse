import { Injectable, Logger } from '@nestjs/common';
import type { InsightContext } from './ai.service';

/**
 * Safety gate for AI auto-execution.
 * Conservative by design — when in doubt, block.
 */
@Injectable()
export class AIGuardService {
  private readonly logger = new Logger(AIGuardService.name);

  canExecute(command: string, context: InsightContext): boolean {
    const state = (context.vehicleState ?? '').toLowerCase();
    const offline = ['offline', 'asleep', 'sleeping'].includes(state);

    switch (command) {
      case 'charge_stop':
        // Block if not actually charging
        if (context.chargingState !== 'Charging') return false;
        // Block if SOC is too low — never interrupt essential charging
        if (context.soc != null && context.soc < 30) {
          this.logger.debug(`Guard blocked charge_stop: SOC too low (${context.soc}%)`);
          return false;
        }
        return true;

      case 'charge_start':
        if (context.chargingState === 'Charging') return false;
        if (context.soc != null && context.soc >= 90) return false;
        if (offline) return false;
        return true;

      case 'auto_conditioning_start':
      case 'auto_conditioning_stop':
      case 'flash_lights':
        if (offline) {
          this.logger.debug(`Guard blocked ${command}: vehicle offline`);
          return false;
        }
        return true;

      case 'door_lock':
        if (offline) return false;
        return true;

      // Security-sensitive — never auto-execute
      case 'door_unlock':
        this.logger.debug('Guard blocked door_unlock: security risk');
        return false;

      case 'honk_horn':
        this.logger.debug('Guard blocked honk_horn: not safe for auto-execute');
        return false;

      default:
        this.logger.debug(`Guard blocked unknown command: ${command}`);
        return false;
    }
  }
}
