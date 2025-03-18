import fs from 'fs';
import path from 'path';
import { Logger } from 'homebridge';

/**
 * SleepMe Diagnostic Logger
 * Provides enhanced logging capabilities for troubleshooting
 */
export class DiagnosticLogger {
  private enabled: boolean;
  private logPath = ''; // Initialize to empty string
  private logStream: fs.WriteStream | null = null;
  private deviceStateLogs: Map<string, DeviceState[]> = new Map();
  private maxEntriesPerDevice = 20; // Maximum history to keep per device
  
  constructor(
    private readonly log: Logger,
    storagePath: string = '',
    enabled: boolean = false
  ) {
    this.enabled = enabled;
    
    // Create log path
    if (storagePath && enabled) {
      try {
        this.logPath = path.join(storagePath, 'sleepme-diagnostics.log');
        this.logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
        this.writeLog('===== SleepMe Diagnostic Logging Started =====');
        this.log.info(`Diagnostic logging enabled, writing to: ${this.logPath}`);
      } catch (error) {
        this.log.error(`Failed to initialize diagnostic log: ${error}`);
        this.enabled = false;
      }
    } else {
      this.enabled = false;
    }
  }
  
  /**
   * Log an API request/response for diagnostics
   */
  logApiTransaction(method: string, url: string, data: any = null, response: any = null, error: any = null): void {
    if (!this.enabled) {
      return;
    }
    
    const timestamp = new Date().toISOString();
    let logEntry = `[${timestamp}] API ${method} ${url}\n`;
    
    // Log request data if present
    if (data) {
      logEntry += `Request Data: ${JSON.stringify(data, null, 2)}\n`;
    }
    
    // Log response if present
    if (response) {
      const responseStr = typeof response === 'object' ? JSON.stringify(response, null, 2) : String(response);
      logEntry += `Response: ${responseStr}\n`;
    }
    
    // Log error if present
    if (error) {
      let errorMessage = '';
      if (error instanceof Error) {
        errorMessage = error.message;
        if ('stack' in error) {
          errorMessage += `\n${error.stack}`;
        }
      } else {
        errorMessage = String(error);
      }
      logEntry += `Error: ${errorMessage}\n`;
    }
    
    logEntry += '-----------------------------------\n';
    this.writeLog(logEntry);
  }
  
  /**
   * Log a device state change
   */
  logDeviceState(deviceId: string, state: DeviceState): void {
    if (!this.enabled) {
      return;
    }
    
    // Store in memory for state comparison
    const deviceStates = this.deviceStateLogs.get(deviceId) || [];
    deviceStates.push(state);
    
    // Limit history size
    if (deviceStates.length > this.maxEntriesPerDevice) {
      deviceStates.shift(); // Remove oldest entry
    }
    
    this.deviceStateLogs.set(deviceId, deviceStates);
    
    // Log the state change
    const timestamp = new Date().toISOString();
    let logEntry = `[${timestamp}] Device ${deviceId} state:\n`;
    logEntry += `  Current Temperature: ${state.currentTemperature}°C\n`;
    logEntry += `  Target Temperature: ${state.targetTemperature}°C\n`;
    logEntry += `  Current State: ${state.currentStateStr}\n`;
    logEntry += `  Target State: ${state.targetStateStr}\n`;
    logEntry += `  Power: ${state.power}\n`;
    logEntry += `  Thermal Status: ${state.thermalStatus}\n`;
    
    // Add state change detection if we have previous states
    if (deviceStates.length > 1) {
      const previousState = deviceStates[deviceStates.length - 2];
      const changes = this.getStateChanges(previousState, state);
      
      if (changes.length > 0) {
        logEntry += 'Changes detected:\n';
        changes.forEach(change => {
          logEntry += `  ${change.property}: ${change.oldValue} → ${change.newValue}\n`;
        });
      }
    }
    
    logEntry += '-----------------------------------\n';
    this.writeLog(logEntry);
  }
  
  /**
   * Get noteable changes between device states
   */
  private getStateChanges(prevState: DeviceState, newState: DeviceState): StateChange[] {
    const changes: StateChange[] = [];
    
    if (prevState.currentTemperature !== newState.currentTemperature) {
      changes.push({
        property: 'Current Temperature',
        oldValue: `${prevState.currentTemperature}°C`,
        newValue: `${newState.currentTemperature}°C`,
      });
    }
    
    if (prevState.targetTemperature !== newState.targetTemperature) {
      changes.push({
        property: 'Target Temperature',
        oldValue: `${prevState.targetTemperature}°C`,
        newValue: `${newState.targetTemperature}°C`,
      });
    }
    
    if (prevState.currentStateStr !== newState.currentStateStr) {
      changes.push({
        property: 'Current State',
        oldValue: prevState.currentStateStr,
        newValue: newState.currentStateStr,
      });
    }
    
    if (prevState.targetStateStr !== newState.targetStateStr) {
      changes.push({
        property: 'Target State',
        oldValue: prevState.targetStateStr,
        newValue: newState.targetStateStr,
      });
    }
    
    if (prevState.power !== newState.power) {
      changes.push({
        property: 'Power',
        oldValue: prevState.power,
        newValue: newState.power,
      });
    }
    
    if (prevState.thermalStatus !== newState.thermalStatus) {
      changes.push({
        property: 'Thermal Status',
        oldValue: prevState.thermalStatus,
        newValue: newState.thermalStatus,
      });
    }
    
    return changes;
  }
  
  /**
   * Write to the diagnostic log file
   */
  private writeLog(message: string): void {
    if (!this.enabled || !this.logStream) {
      return;
    }
    
    try {
      this.logStream.write(message + '\n');
    } catch (error) {
      this.log.error(`Failed to write to diagnostic log: ${error}`);
      this.enabled = false;
    }
  }
  
  /**
   * Close the log file
   */
  shutdown(): void {
    if (this.logStream) {
      this.writeLog('===== SleepMe Diagnostic Logging Ended =====');
      this.logStream.end();
      this.logStream = null;
    }
  }
}

/**
 * Interface for device state logging
 */
interface DeviceState {
  currentTemperature: number;
  targetTemperature: number;
  currentState: number;
  currentStateStr: string;
  targetState: number;
  targetStateStr: string;
  power: string;
  thermalStatus: string;
  timestamp: Date;
}

/**
 * Interface for tracking state changes
 */
interface StateChange {
  property: string;
  oldValue: string;
  newValue: string;
}