import axios from 'axios';
import { API, AccessoryPlugin, Logging, AccessoryConfig, Service, Characteristic } from 'homebridge';

let HomebridgeService: typeof Service;
let Characteristic: typeof Characteristic;

export default (homebridge: API) => {
  HomebridgeService = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory("homebridge-sleepmepro", "SleepMeAccessory", SleepMeAccessory);
};

class SleepMeAccessory implements AccessoryPlugin {
  private readonly log: Logging;
  private readonly name: string;
  private readonly apiToken: string;
  private unit: string;
  private schedule: any[];
  private currentTemperature: number;
  private targetTemperature: number;
  private currentHeatingState: number;
  private apiCallCount: number;
  private apiCallTimestamp: number;
  private service: Service;
  private scheduleTimer: NodeJS.Timeout | null;

  constructor(log: Logging, config: AccessoryConfig) {
    this.log = log;
    this.name = config.name;
    this.apiToken = config.apiToken;
    this.unit = config.unit || "C"; // Default to Celsius
    this.schedule = config.schedule || [];

    // Current state
    this.currentTemperature = 20; // Default starting value
    this.targetTemperature = 20;  // Default starting value
    this.currentHeatingState = 0; // 0 = OFF, 1 = HEAT

    // Rate limiting
    this.apiCallCount = 0;
    this.apiCallTimestamp = Date.now();

    // Initialize the thermostat service
    this.service = new HomebridgeService.Thermostat(this.name);

    // Required characteristics
    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .on("get", this.getCurrentTemperature.bind(this));

    this.service
      .getCharacteristic(Characteristic.TargetTemperature)
      .on("get", this.getTargetTemperature.bind(this))
      .on("set", this.setTemperature.bind(this))
      .setProps({
        minValue: 10, // Minimum allowed temperature (in Celsius)
        maxValue: 35, // Maximum allowed temperature (in Celsius)
        minStep: 0.5  // Temperature adjustment increments
      });

    this.service
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .on("get", this.getCurrentHeatingCoolingState.bind(this));

    this.service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .on("get", this.getTargetHeatingCoolingState.bind(this))
      .on("set", this.setTargetHeatingCoolingState.bind(this));

    this.service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .on("get", this.getTemperatureDisplayUnits.bind(this))
      .on("set", this.setTemperatureDisplayUnits.bind(this));

    // Start the schedule checker
    this.scheduleTimer = setInterval(() => this.checkSchedule(), 60000); // Check every minute

    // Initial update
    this.updateDeviceStatus();
  }

  // Convert temperatures
  private celsiusToFahrenheit(celsius: number): number {
    return (celsius * 9 / 5) + 32;
  }

  private fahrenheitToCelsius(fahrenheit: number): number {
    return (fahrenheit - 32) * 5 / 9;
  }

  // Rate limiting function
  private rateLimitApiCall(callback: () => void): void {
    const now = Date.now();
    const oneMinute = 60000;

    if (now - this.apiCallTimestamp > oneMinute) {
      // Reset the counter and timestamp if more than a minute has passed
      this.apiCallCount = 0;
      this.apiCallTimestamp = now;
    }

    if (this.apiCallCount < 9) {
      this.apiCallCount++;
      callback();
    } else {
      this.log.warn("API call rate limit exceeded. Please wait before making more requests.");
    }
  }

  // Update device status
  private updateDeviceStatus(): void {
    this.rateLimitApiCall(() => {
      interface DeviceStatusResponse {
        temperature: number;
        targetTemperature?: number;
        isHeating?: boolean;
      }

      axios.get<DeviceStatusResponse>('https://api.app.sleep.me/v1/device/status', {
        headers: { Authorization: `Bearer ${this.apiToken}` }
      })
      .then((response) => {
        this.currentTemperature = response.data.temperature;
        if (response.data.targetTemperature !== undefined) {
          this.targetTemperature = response.data.targetTemperature;
        }
        if (response.data.isHeating !== undefined) {
          this.currentHeatingState = response.data.isHeating ? 1 : 0;
        }
        this.log.debug(`Device status updated: Current temp: ${this.currentTemperature}°C, Target: ${this.targetTemperature}°C, Heating: ${this.currentHeatingState}`);
      })
      .catch((error) => {
        this.log.error("Error updating device status:", error.message);
        // Retry logic or additional error handling can be added here
      });
    });
  }

  // Characteristic getter/setter methods
  private getCurrentTemperature(callback: (error: Error | null, value?: number) => void): void {
    this.updateDeviceStatus(); // Refresh the status

    const temp = this.unit === "F" ? 
      this.celsiusToFahrenheit(this.currentTemperature) : 
      this.currentTemperature;

    this.log.debug(`Getting current temperature: ${temp}°${this.unit}`);
    callback(null, this.currentTemperature); // HomeKit expects Celsius
  }

  private getTargetTemperature(callback: (error: Error | null, value?: number) => void): void {
    const temp = this.unit === "F" ? 
      this.celsiusToFahrenheit(this.targetTemperature) : 
      this.targetTemperature;

    this.log.debug(`Getting target temperature: ${temp}°${this.unit}`);
    callback(null, this.targetTemperature); // HomeKit expects Celsius
  }

  private setTemperature(temp: number, callback: (error?: Error) => void): void {
    let targetTemp = temp;
    const displayTemp = this.unit === "F" ? this.celsiusToFahrenheit(targetTemp) : targetTemp;

    this.rateLimitApiCall(() => {
      axios.post('https://api.app.sleep.me/v1/device/setTemperature', {
        temperature: targetTemp
      }, {
        headers: { Authorization: `Bearer ${this.apiToken}` }
      })
      .then(() => {
        this.targetTemperature = targetTemp;
        this.log(`Temperature set to ${displayTemp.toFixed(1)}°${this.unit}`);
        callback(undefined);
      })
      .catch(error => {
        this.log.error("Error setting temperature:", error.message);
        callback(error);
      });
    });
  }

  private getCurrentHeatingCoolingState(callback: (error: Error | null, value?: number) => void): void {
    callback(null, this.currentHeatingState);
  }

  private getTargetHeatingCoolingState(callback: (error: Error | null, value?: number) => void): void {
    // For simplicity, we'll assume the target state is the same as current
    callback(null, this.currentHeatingState > 0 ? 1 : 0);
  }

  private setTargetHeatingCoolingState(state: number, callback: (error?: Error) => void): void {
    // Implement this if your device supports turning heating on/off
    // For now, just acknowledge the request
    this.log(`Set target heating state to: ${state}`);
    callback(null);
  }

  private getTemperatureDisplayUnits(callback: (error: Error | null, value?: number) => void): void {
    const units = this.unit === "F" ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT : 
                                     Characteristic.TemperatureDisplayUnits.CELSIUS;
    callback(null, units);
  }

  private setTemperatureDisplayUnits(units: number, callback: (error?: Error) => void): void {
    this.unit = units === Characteristic.TemperatureDisplayUnits.FAHRENHEIT ? "F" : "C";
    this.log(`Display units set to: ${this.unit}`);
    callback(null);
  }

  private checkSchedule(): void {
    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 5); // Get HH:MM format

    for (const entry of this.schedule) {
      // Check for warm awake scheduling
      if (entry.warmAwake && entry.time) {
        const [hours, minutes] = entry.time.split(':').map(Number);
        const wakeTime = new Date(now);
        wakeTime.setHours(hours, minutes, 0, 0);

        // Calculate warm-up start time
        const warmUpTime = new Date(wakeTime);
        warmUpTime.setMinutes(warmUpTime.getMinutes() - entry.warmAwake);

        // Format for comparison
        const warmUpTimeString = warmUpTime.toTimeString().slice(0, 5);

        if (currentTime === warmUpTimeString) {
          const tempChange = this.unit === "F" ? 2 : 1; // 2°F or 1°C increase
          const warmTemp = entry.temperature + tempChange;

          this.log(`Warm Awake: Gradually increasing to ${warmTemp}°${this.unit} before wake time ${entry.time}`);
          this.setTemperature(warmTemp, () => {});
        }
      }

      // Regular schedule check
      if (entry.time === currentTime) {
        // Convert temperature if needed
        let targetTemp = entry.temperature;
        if (this.unit === "F") {
          targetTemp = this.fahrenheitToCelsius(targetTemp);
        }

        this.setTemperature(targetTemp, () => {});
        this.log(`Scheduled change: Set temperature to ${entry.temperature}°${this.unit} at ${entry.time}`);
      }
    }
  }

  getServices(): Service[] {
    return [this.service];
  }

  // Clean up on shutdown
  shutdown(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
    }
  }
}