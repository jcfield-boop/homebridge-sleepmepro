import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SleepMePlatform } from './platform.js';
import { SleepMeApi } from './sleepme-api.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class SleepMePlatformAccessory {
  private service: Service;
  private targetTemperature = 21; // Default value
  private currentTemperature = 21; // Default value
  private currentHeatingState = 0;
  private targetHeatingState = 0;
  private deviceId: string;
  private firmwareVersion = 'Unknown';
  private isUpdating = false;
  private lastUpdateTime = 0;
  
  // Temperature limits
  private readonly MIN_TEMP = 13; // 55°F
  private readonly MAX_TEMP = 46; // 115°F
  private readonly TEMP_STEP = 0.5;

  constructor(
    private readonly platform: SleepMePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly apiService: SleepMeApi,
  ) {
    // Validate we have a device ID
    if (!this.accessory.context.device || !this.accessory.context.device.id) {
      this.platform.log.error(`Accessory missing device ID: ${this.accessory.displayName}`);
      // We'll still set up the accessory, but it won't function without a valid ID
    }
    
    // Get device ID
    this.deviceId = this.accessory.context.device?.id || '';

    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Sleepme Inc.')
      .setCharacteristic(this.platform.Characteristic.Model, 'ChiliPad')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.UUID);

    // Get device name (use override if available)
    let deviceName = this.accessory.context.device?.name || this.accessory.displayName;
    if (this.platform.config.devices) {
      const override = this.platform.config.devices.find((d: { id: string }) => d.id === this.deviceId);
      if (override && override.name) {
        deviceName = override.name;
        this.platform.log.debug(`Using override name for device ${this.deviceId}: ${deviceName}`);
      }
    }

    // Set up the service
    this.service = this.accessory.getService(this.platform.Service.Thermostat) || 
      this.accessory.addService(this.platform.Service.Thermostat, deviceName);

    // Set name characteristic
    this.service.setCharacteristic(this.platform.Characteristic.Name, deviceName);

    // Configure temperature range (min, max, step)
    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .setProps({
        minValue: this.MIN_TEMP,
        maxValue: this.MAX_TEMP,
        minStep: this.TEMP_STEP,
      })
      .onSet(this.setTargetTemperature.bind(this))
      .onGet(this.getTargetTemperature.bind(this));

    // Register handlers for other required characteristics
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onSet(this.setTargetHeatingCoolingState.bind(this))
      .onGet(this.getTargetHeatingCoolingState.bind(this));

    // Set temperature display units based on config
    const displayUnits = this.platform.config.unit === 'C' 
      ? this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS
      : this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    
    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .updateValue(displayUnits);

    // Initialize device status if we have a valid device ID
    if (this.deviceId) {
      this.refreshDeviceStatus()
        .catch((error: Error) => this.platform.log.error(`Error initializing device status: ${error.message}`));

      // Set up periodic polling with 60 second interval
      setInterval(() => {
        if (this.deviceId) {
          this.refreshDeviceStatus()
            .catch((error: Error) => this.platform.log.error(`Error updating device status: ${error.message}`));
        }
      }, 60000);
    }
  }

  /**
   * Get the current temperature
   */
  async getCurrentTemperature(): Promise<CharacteristicValue> {
    return this.currentTemperature;
  }

  /**
   * Get the target temperature
   */
  async getTargetTemperature(): Promise<CharacteristicValue> {
    return this.targetTemperature;
  }

  /**
   * Get the current heating/cooling state
   */
  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.currentHeatingState;
  }

  /**
   * Get the target heating/cooling state
   */
  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.targetHeatingState;
  }

  /**
   * Set target temperature for the device
   * This is called when the user adjusts the temperature in HomeKit
   */
  async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    try {
      if (!this.deviceId) {
        throw new Error('Missing device ID, cannot update temperature');
      }
      
      const newTemp = this.ensureValidTemperature(value as number);
      this.platform.log.info(`Setting target temperature to ${newTemp}°C for device ${this.deviceId}`);
      
      // First check if we need to turn device on
      if (this.targetHeatingState === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
        this.platform.log.debug(`Device is currently OFF, turning ON with new temperature`);
        
        // Turn on the device with the new temperature
        await this.apiService.turnDeviceOn(this.deviceId, newTemp);
        
        // Update the heating state to AUTO
        this.targetHeatingState = this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
        this.service.updateCharacteristic(
          this.platform.Characteristic.TargetHeatingCoolingState,
          this.targetHeatingState
        );
      } else {
        // Device already on, just set temperature
        await this.apiService.setTemperature(this.deviceId, newTemp);
      }
      
      // Update our local value
      this.targetTemperature = newTemp;
      
      // Add short delay then update device status to reflect changes
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.refreshDeviceStatus();
      
      this.platform.log.info(`Target temperature set to ${newTemp}°C for device ${this.deviceId}`);
    } catch (error) {
      if (error instanceof Error) {
        this.platform.log.error(`Error setting target temperature: ${error.message}`);
      } else {
        this.platform.log.error('Unknown error setting target temperature');
      }
      throw error;
    }
  }

  /**
   * Map HomeKit thermostat state to SleepMe control
   * This is called when the user changes the thermostat mode in HomeKit
   */
  async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    try {
      if (!this.deviceId) {
        throw new Error('Missing device ID, cannot update heating state');
      }
      
      const state = value as number;
      this.platform.log.info(`Setting target state to ${this.getHeatingStateName(state)} for device ${this.deviceId}`);
      
      this.targetHeatingState = state;
      
      switch (state) {
        case this.platform.Characteristic.TargetHeatingCoolingState.OFF: {
          // Simply turn the device off
          await this.apiService.turnDeviceOff(this.deviceId);
          break;
        }
          
        case this.platform.Characteristic.TargetHeatingCoolingState.HEAT: {
          // For heat mode, set a temperature higher than current
          const heatingTemp = Math.max(this.currentTemperature + 2, this.targetTemperature);
          const validTemp = this.ensureValidTemperature(heatingTemp);
          
          // Turn on with the heating temperature
          await this.apiService.turnDeviceOn(this.deviceId, validTemp);
          
          // Update our local target temperature
          this.targetTemperature = validTemp;
          this.service.updateCharacteristic(
            this.platform.Characteristic.TargetTemperature,
            this.targetTemperature
          );
          break;
        }
          
        case this.platform.Characteristic.TargetHeatingCoolingState.COOL: {
          // For cool mode, set a temperature lower than current
          const coolingTemp = Math.min(this.currentTemperature - 2, this.targetTemperature);
          const validTemp = this.ensureValidTemperature(coolingTemp);
          
          // Turn on with the cooling temperature
          await this.apiService.turnDeviceOn(this.deviceId, validTemp);
          
          // Update our local target temperature
          this.targetTemperature = validTemp;
          this.service.updateCharacteristic(
            this.platform.Characteristic.TargetTemperature,
            this.targetTemperature
          );
          break;
        }
          
        case this.platform.Characteristic.TargetHeatingCoolingState.AUTO: {
          // For auto mode, just turn on with current target temp
          await this.apiService.turnDeviceOn(this.deviceId, this.targetTemperature);
          break;
        }
      }
      
      // Add short delay then update device status to reflect changes
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.refreshDeviceStatus();
      
      this.platform.log.info(
        `Set heating state to ${this.getHeatingStateName(state)} for device ${this.deviceId}`
      );
    } catch (error) {
      if (error instanceof Error) {
        this.platform.log.error(`Error setting target heating state: ${error.message}`);
      } else {
        this.platform.log.error('Unknown error setting target heating state');
      }
      throw error;
    }
  }

  /**
   * Update device status from the API
   * This polls the device and updates HomeKit with current state
   */
  async refreshDeviceStatus(): Promise<void> {
    // Prevent multiple concurrent updates
    if (this.isUpdating || !this.deviceId) {
      return;
    }

    // Throttle updates (max once every 10 seconds)
    const now = Date.now();
    if (now - this.lastUpdateTime < 10000) {
      this.platform.log.debug(`Skipping update - too soon since last update (${Math.floor((now - this.lastUpdateTime)/1000)}s)`);
      return;
    }

    this.isUpdating = true;
    this.lastUpdateTime = now;
    
    try {
      this.platform.log.debug(`Updating status for device ${this.deviceId}`);
      const deviceStatus = await this.apiService.getDeviceStatus(this.deviceId);
      
      if (!deviceStatus) {
        this.platform.log.error(`Failed to get status for device ${this.deviceId}`);
        return;
      }

      // Update firmware version if available
      if (deviceStatus["about.firmware_version"]) {
        this.firmwareVersion = deviceStatus["about.firmware_version"];
        this.accessory.getService(this.platform.Service.AccessoryInformation)?.
          updateCharacteristic(this.platform.Characteristic.FirmwareRevision, this.firmwareVersion);
      }

      // Update temperature values
      if (deviceStatus["control.current_temperature_c"] !== undefined) {
        this.currentTemperature = this.ensureValidTemperature(deviceStatus["control.current_temperature_c"]);
        this.service.updateCharacteristic(
          this.platform.Characteristic.CurrentTemperature, 
          this.currentTemperature
        );
      }
      
      if (deviceStatus["control.target_temperature_c"] !== undefined) {
        this.targetTemperature = this.ensureValidTemperature(deviceStatus["control.target_temperature_c"]);
        this.service.updateCharacteristic(
          this.platform.Characteristic.TargetTemperature, 
          this.targetTemperature
        );
      }

      // Determine device power state
      const powerState = deviceStatus["control.power"] || '';
      const thermalStatus = deviceStatus["control.thermal_control_status"] || '';
      
      // Map SleepMe states to HomeKit states
      let isDeviceOn = powerState === 'on';
      
      // If power state isn't explicitly available, use the thermal status
      if (powerState === '') {
        isDeviceOn = thermalStatus !== '' && thermalStatus !== 'standby';
      }
      
      if (!isDeviceOn) {
        // Device is off
        this.currentHeatingState = this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
        this.targetHeatingState = this.platform.Characteristic.TargetHeatingCoolingState.OFF;
        this.platform.log.debug(`Device is OFF (power: ${powerState}, thermal: ${thermalStatus})`);
      } else {
        // Device is on - determine heating/cooling state
        if (thermalStatus === 'heating' || 
            (thermalStatus === 'active' && this.targetTemperature > this.currentTemperature + 0.5)) {
          // Actively heating
          this.currentHeatingState = this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
          this.platform.log.debug(`Device is HEATING (${this.currentTemperature}°C → ${this.targetTemperature}°C)`);
        } else if (thermalStatus === 'cooling' || 
                 (thermalStatus === 'active' && this.targetTemperature < this.currentTemperature - 0.5)) {
          // Actively cooling
          this.currentHeatingState = this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
          this.platform.log.debug(`Device is COOLING (${this.currentTemperature}°C → ${this.targetTemperature}°C)`);
        } else {
          // Device is idle or maintaining temperature
          this.currentHeatingState = this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
          this.platform.log.debug(`Device is maintaining temperature (${this.currentTemperature}°C ≈ ${this.targetTemperature}°C)`);
        }
        
        // Update target state if it was OFF but the device is actually on
        if (this.targetHeatingState === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
          this.targetHeatingState = this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
        }
      }
      
      // Update HomeKit characteristics
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState, 
        this.currentHeatingState
      );
      
      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetHeatingCoolingState, 
        this.targetHeatingState
      );

      this.platform.log.debug(
        `Updated device status: Current=${this.currentTemperature.toFixed(1)}°C, ` +
        `Target=${this.targetTemperature.toFixed(1)}°C, ` +
        `State=${this.getHeatingStateName(this.currentHeatingState)}, ` +
        `Power=${powerState}, ThermalStatus=${thermalStatus}`
      );
    } catch (error) {
      if (error instanceof Error) {
        this.platform.log.error(`Error updating device status: ${error.message}`);
      } else {
        this.platform.log.error(`Unknown error updating device status`);
      }
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * Get the text name for a heating/cooling state
   * Helper method for better logging
   */
  private getHeatingStateName(state: number): string {
    switch (state) {
      case this.platform.Characteristic.CurrentHeatingCoolingState.OFF:
      case this.platform.Characteristic.TargetHeatingCoolingState.OFF:
        return 'OFF';
      case this.platform.Characteristic.CurrentHeatingCoolingState.HEAT:
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
        return 'HEAT';
      case this.platform.Characteristic.CurrentHeatingCoolingState.COOL:
      case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
        return 'COOL';
      case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
        return 'AUTO';
      default:
        return `UNKNOWN(${state})`;
    }
  }

  /**
   * Ensure temperature is within valid range
   * Helper method to validate temperatures
   */
  private ensureValidTemperature(temp: number): number {
    if (typeof temp !== 'number' || isNaN(temp)) {
      return this.targetTemperature || 21;
    }
    
    if (temp < this.MIN_TEMP) {
      this.platform.log.warn(`Temperature ${temp}°C below minimum, using ${this.MIN_TEMP}°C`);
      return this.MIN_TEMP;
    }
    
    if (temp > this.MAX_TEMP) {
      this.platform.log.warn(`Temperature ${temp}°C above maximum, using ${this.MAX_TEMP}°C`);
      return this.MAX_TEMP;
    }
    
    // Round to the nearest 0.5 degree
    return Math.round(temp * 2) / 2;
  }
}