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
      this.updateDeviceStatus()
        .catch(error => this.platform.log.error(`Error initializing device status: ${error}`));

      // Set up periodic polling - Using 60 seconds interval to avoid rate limiting issues
      setInterval(() => {
        if (this.deviceId) {
          this.updateDeviceStatus()
            .catch(error => this.platform.log.error(`Error updating device status: ${error}`));
        }
      }, 60000); // Every 60 seconds (reduced from 30 seconds to avoid rate limiting)
    }
  }

  async updateDeviceStatus(): Promise<void> {
    if (this.isUpdating || !this.deviceId) {
      return;
    }

    this.isUpdating = true;
    try {
      this.platform.log.debug(`Updating status for device ${this.deviceId}`);
      const deviceStatus = await this.apiService.getDeviceStatus(this.deviceId);
      
      if (!deviceStatus) {
        this.platform.log.error(`Failed to get status for device ${this.deviceId}`);
        return;
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

      // Update heating/cooling state based on thermal status and temperature difference
      const thermalStatus = deviceStatus["control.thermal_control_status"] || '';
      
      // Determine the current state based on thermal status and temperature comparison
      if (thermalStatus === 'heating' || 
          (thermalStatus === 'active' && this.targetTemperature > this.currentTemperature + 0.5)) {
        this.currentHeatingState = this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
        this.platform.log.debug(`Device is heating (status: ${thermalStatus})`);
      } else if (thermalStatus === 'cooling' || 
                (thermalStatus === 'active' && this.targetTemperature < this.currentTemperature - 0.5)) {
        this.currentHeatingState = this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
        this.platform.log.debug(`Device is cooling (status: ${thermalStatus})`);
      } else if (thermalStatus === 'active') {
        // If status is active but temperatures are close, device is maintaining temperature
        this.currentHeatingState = this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
        this.platform.log.debug(`Device is active (maintaining temperature)`);
      } else if (thermalStatus === 'off' || thermalStatus === 'standby') {
        // If explicitly off or in standby
        this.currentHeatingState = this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
        this.platform.log.debug(`Device is off/standby (status: ${thermalStatus})`);
      } else {
        // Default behavior for unknown states
        this.platform.log.debug(`Unknown thermal status: "${thermalStatus}", using temperature difference`);
        if (this.targetTemperature > this.currentTemperature + 0.5) {
          this.currentHeatingState = this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
        } else if (this.targetTemperature < this.currentTemperature - 0.5) {
          this.currentHeatingState = this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
        } else {
          this.currentHeatingState = this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
        }
      }
      
      // Update the target heating state to match current if it's not already set
      if (this.targetHeatingState === this.platform.Characteristic.TargetHeatingCoolingState.OFF &&
          this.currentHeatingState !== this.platform.Characteristic.CurrentHeatingCoolingState.OFF) {
        this.targetHeatingState = this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
      } else if (this.currentHeatingState === this.platform.Characteristic.CurrentHeatingCoolingState.OFF &&
                 this.targetHeatingState !== this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
        this.targetHeatingState = this.platform.Characteristic.TargetHeatingCoolingState.OFF;
      }
      
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
        `ThermalStatus=${thermalStatus}`
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

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    return this.currentTemperature;
  }

  async getTargetTemperature(): Promise<CharacteristicValue> {
    return this.targetTemperature;
  }

  async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    try {
      if (!this.deviceId) {
        throw new Error('Missing device ID, cannot update temperature');
      }
      
      const newTemp = this.ensureValidTemperature(value as number);
      this.platform.log.debug(`Setting target temperature to ${newTemp}°C for device ${this.deviceId}`);
      
      await this.apiService.setDeviceSettings(this.deviceId, {
        "control.set_temperature_c": newTemp
      });
      
      this.targetTemperature = newTemp;
      this.platform.log.info(`Target temperature set to ${newTemp}°C for device ${this.deviceId}`);
      
      // If the device is currently OFF but we're setting a temperature, turn it ON
      if (this.targetHeatingState === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
        this.targetHeatingState = this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
        this.service.updateCharacteristic(
          this.platform.Characteristic.TargetHeatingCoolingState,
          this.targetHeatingState
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        this.platform.log.error(`Error setting target temperature: ${error.message}`);
      } else {
        this.platform.log.error('Unknown error setting target temperature');
      }
      throw error;
    }
  }

  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.currentHeatingState;
  }

  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.targetHeatingState;
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    try {
      if (!this.deviceId) {
        throw new Error('Missing device ID, cannot update heating state');
      }
      
      const state = value as number;
      this.platform.log.debug(`Setting target heating state to ${this.getHeatingStateName(state)} for device ${this.deviceId}`);
      
      this.targetHeatingState = state;
      
      // Handle different states
      switch (state) {
        case this.platform.Characteristic.TargetHeatingCoolingState.OFF: {
          // Turn off the device
          await this.apiService.setDeviceSettings(this.deviceId, {
            "control.thermal_control_status": "off"
          });
          break;
        }
          
        case this.platform.Characteristic.TargetHeatingCoolingState.HEAT: {
          // Set to heating mode (target > current)
          const heatingTemp = this.ensureValidTemperature(
            Math.max(this.currentTemperature + 2, this.targetTemperature)
          );
          await this.apiService.setDeviceSettings(this.deviceId, {
            "control.set_temperature_c": heatingTemp,
            "control.thermal_control_status": "active"
          });
          this.targetTemperature = heatingTemp;
          this.service.updateCharacteristic(
            this.platform.Characteristic.TargetTemperature,
            this.targetTemperature
          );
          break;
        }
          
        case this.platform.Characteristic.TargetHeatingCoolingState.COOL: {
          // Set to cooling mode (target < current)
          const coolingTemp = this.ensureValidTemperature(
            Math.min(this.currentTemperature - 2, this.targetTemperature)
          );
          await this.apiService.setDeviceSettings(this.deviceId, {
            "control.set_temperature_c": coolingTemp,
            "control.thermal_control_status": "active"
          });
          this.targetTemperature = coolingTemp;
          this.service.updateCharacteristic(
            this.platform.Characteristic.TargetTemperature,
            this.targetTemperature
          );
          break;
        }
          
        case this.platform.Characteristic.TargetHeatingCoolingState.AUTO: {
          // Just use the current target temperature
          await this.apiService.setDeviceSettings(this.deviceId, {
            "control.set_temperature_c": this.targetTemperature,
            "control.thermal_control_status": "active"
          });
          break;
        }
      }
      
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

  // Helper function to get readable state name
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
  
  // Helper to ensure temperature is within valid range
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