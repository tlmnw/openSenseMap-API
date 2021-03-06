'use strict';

/**
 * define for the senseBox request body encoded in JSON
 * @apiDefine RequestBody JSON request body
 */

/**
 * @apiDefine CommonBoxJSONBody
 *
 * @apiParam (RequestBody) {String} name the name of this senseBox.
 * @apiParam (RequestBody) {String} grouptag the grouptag of this senseBox.
 * @apiParam (RequestBody) {String="indoor","outdoor"} exposure the exposure of this senseBox.
 * @apiParam (RequestBody) {String="fixed"} boxType the type of the senseBox. Currently only 'fixed' is supported.
 * @apiParam (RequestBody) {String="homeEthernet","homeWifi"} model specify the model if you want to use a predefined senseBox model.
 * @apiParam (RequestBody) {Sensor[]} sensors an array containing the sensors of this senseBox. Only use if model is unspecified
 * @apiParam (RequestBody) {MqttOption} sensors an array containing the sensors of this senseBox.
 * @apiParam (RequestBody) {Location} loc the location of this senseBox. Must be a GeoJSON Point Feature. (RFC7946)
 *
 */

/**
 * @apiDefine BoxIdParam
 *
 * @apiParam {String} :senseBoxId the ID of the senseBox you are referring to.
 */

const { mongoose } = require('../db'),
  timestamp = require('mongoose-timestamp'),
  Schema = mongoose.Schema,
  { schema: sensorSchema, model: Sensor } = require('./sensor'),
  integrations = require('./integrations'),
  sensorLayouts = require('../sensorLayouts'),
  mqttClient = require('../mqtt'),
  Measurement = require('./measurement').model,
  { parseTimestamp, config: { api_measurements_post_domain, imageFolder } } = require('../utils'),
  transform = require('stream-transform'),
  log = require('../log'),
  ModelError = require('./modelError'),
  Sketcher = require('@sensebox/sketch-templater'),
  fs = require('fs');

const templateSketcher = new Sketcher(api_measurements_post_domain);

//Location schema
const locationSchema = new Schema({
  type: {
    type: String,
    required: true,
    default: 'Feature',
    enum: ['Feature', 'feature']
  },
  geometry: {
    type: {
      type: String,
      required: true,
      default: 'Point',
      enum: ['Point', 'point']
    },
    coordinates: {
      type: Array,
      required: true
    }
  },
  properties: Schema.Types.Mixed
});
locationSchema.index({ 'geometry': '2dsphere' });

locationSchema.set('toJSON', {
  version: false,
  transform: function transform (doc, ret) {
    delete ret._id;

    return ret;
  }
});

//senseBox schema
const boxSchema = new Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  loc: {
    type: [locationSchema],
    required: true
  },
  boxType: {
    type: String,
    trim: true,
    required: true,
    enum: ['fixed']
  },
  exposure: {
    type: String,
    trim: true,
    required: true,
    enum: ['unknown', 'indoor', 'outdoor']
  },
  grouptag: {
    type: String,
    trim: true,
    required: false
  },
  model: {
    type: String,
    required: true,
    trim: true,
    default: 'custom',
    enum: ['custom', ...sensorLayouts.models]
  },
  weblink: {
    type: String,
    trim: true,
    required: false
  },
  description: {
    type: String,
    trim: true,
    required: false
  },
  image: {
    type: String,
    trim: true,
    required: false,
    /* eslint-disable func-name-matching */
    set: function imageSetter ({ type, data }) {
    /* eslint-enable func-name-matching */
      if (type && data) {
        const filename = `${this._id}_${Math.round(Date.now() / 1000).toString(36)}.${type}`;
        try {
          fs.writeFileSync(`${imageFolder}${filename}`, data);
        } catch (err) {
          log.warn(err);

          return;
        }

        return filename;
      }
    }
  },
  sensors: {
    type: [sensorSchema],
    required: [true, 'sensors are required if model is invalid or missing.'],
  }
});
boxSchema.plugin(timestamp);

const BOX_PROPS_FOR_POPULATION = {
  boxType: 1,
  createdAt: 1,
  exposure: 1,
  model: 1,
  grouptag: 1,
  image: 1,
  name: 1,
  updatedAt: 1,
  'loc.geometry': 1,
  'loc.type': 1,
  sensors: 1,
  description: 1,
  weblink: 1,
};

const BOX_SUB_PROPS_FOR_POPULATION = [
  {
    path: 'sensors.lastMeasurement', select: { value: 1, createdAt: 1, _id: 0 }
  }
];

boxSchema.set('toJSON', {
  version: false,
  transform: function transform (doc, ret, options) {
    const box = {};

    for (const prop of Object.keys(BOX_PROPS_FOR_POPULATION)) {
      box[prop] = ret[prop];
    }
    box._id = ret._id;
    box.loc = ret.loc;

    if (options && options.includeSecrets) {
      box.integrations = ret.integrations;
    }

    return box;
  }
});

boxSchema.pre('save', function boxPreSave (next) {
  // check if sensors have been changed
  if (this.modifiedPaths && typeof this.modifiedPaths === 'function') {
    this._sensorsChanged = this.modifiedPaths().some(function eachPath (path) {
      return path.includes('sensors');
    });
  }

  // if sensors have been changed
  if (this._sensorsChanged === true) {
    // find out if sensors are marked for deletion
    this._deleteMeasurementsOf = [];
    for (const sensor of this.sensors) {
      if (sensor._deleteMe === true) {
        this._deleteMeasurementsOf.push(sensor._id);
        this.sensors.pull({ _id: sensor._id });
      }
    }
  }
  next();
});

boxSchema.post('save', function boxPostSave (savedBox) {
  // only run if sensors have changed..
  if (this._sensorsChanged === true) {
    // delete measurements of deleted sensors
    if (savedBox._deleteMeasurementsOf && savedBox._deleteMeasurementsOf.length !== 0) {
      Measurement.remove({ sensor_id: { $in: savedBox._deleteMeasurementsOf } }).exec();
    }
  }
});

// initializes and saves new box document
boxSchema.statics.initNew = function ({
  name,
  boxType,
  loc,
  grouptag,
  exposure,
  model,
  sensors,
  weblink,
  mqtt: {
    enabled, url, topic, decodeOptions: mqttDecodeOptions, connectionOptions, messageFormat
  } = { enabled: false },
  ttn: { app_id, dev_id, port, profile, decodeOptions: ttnDecodeOptions } = {}
}) {
  // if model is not empty, get sensor definitions from products
  // otherwise, sensors should not be empty
  if (model && sensors) {
    return Promise.reject(new ModelError('Parameters model and sensors cannot be specified at the same time.', { type: 'UnprocessableEntityError' }));
  } else if (model && !sensors) {
    sensors = sensorLayouts.getSensorsForModel(model);
  }

  const integrations = {
    mqtt: { enabled, url, topic, decodeOptions: mqttDecodeOptions, connectionOptions, messageFormat },
  };

  if (app_id && dev_id && profile) {
    integrations.ttn = { app_id, dev_id, port, profile, decodeOptions: ttnDecodeOptions };
  }

  // create box document and persist in database
  return this.create({
    name,
    boxType,
    loc,
    grouptag,
    exposure,
    model,
    sensors,
    weblink,
    integrations
  });

};

boxSchema.statics.connectMQTTBoxes = function () {
  this.find({ 'integrations.mqtt.enabled': true })
    .exec()
    .then(function (mqttBoxes) {
      mqttBoxes.forEach(mqttClient.connect);
    });
};

boxSchema.statics.findAndPopulateBoxById = function (id, opts) {
  let populationProps = {};
  Object.assign(populationProps, BOX_PROPS_FOR_POPULATION);

  if (opts) {
    if (opts.includeSecrets) {
      populationProps.integrations = 1;
    }
    if (opts.onlyLastMeasurements) {
      populationProps = {
        sensors: 1
      };
    }
  }

  return this.findById(id, populationProps)
    .populate(BOX_SUB_PROPS_FOR_POPULATION)
    .lean()
    .exec();
};

boxSchema.statics.findByIdAndUpdateLastMeasurementOfSensor = function findByIdAndUpdateLastMeasurementOfSensor (id, sensorId, shouldQueryLatestMeasurement) {
  let newLastMeasurementPromise = Promise.resolve();
  if (typeof shouldQueryLatestMeasurement !== 'undefined' && shouldQueryLatestMeasurement === true) {
    newLastMeasurementPromise = Measurement.findLastMeasurementOfSensor(sensorId);
  }

  return newLastMeasurementPromise
    .then((newLastMeasurement) => { // arrow function for scope
      if (newLastMeasurement && Array.isArray(newLastMeasurement) && newLastMeasurement.length !== 0) {
        newLastMeasurement = newLastMeasurement[0]._id;
      } else { // reply was just an empty array
        newLastMeasurement = undefined;
      }

      return this.findById(id) // scope is used here
        .populate('sensor.lastMeasurement')
        .exec()
        .then(function (box) {
          const sensorIndex = box.sensors.findIndex(s => s._id.equals(sensorId));
          if (sensorIndex === -1) {
            throw new Error('SENSOR_NOT_FOUND');
          }

          box.set(`sensors.${sensorIndex}.lastMeasurement`, newLastMeasurement);

          return box.save();
        });
    });
};

boxSchema.methods.saveMeasurement = function (measurement) {
  const box = this;
  for (let i = box.sensors.length - 1; i >= 0; i--) {
    if (box.sensors[i]._id.equals(measurement.sensor_id)) {
      const m = new Measurement(measurement);

      box.sensors[i].lastMeasurement = m._id;

      return Promise.all([
        box.save(),
        m.save()
      ]);
    } else if (i === 0) { // the loop iterates down. if i is zero, no sensor was found with this id in the box
      return Promise.reject(`Sensor not found: Sensor ${measurement.sensor_id} of box ${box._id} not found`);
    }
  }
};

boxSchema.methods.sensorIds = function () {
  const sensorIds = [];
  for (let i = this.sensors.length - 1; i >= 0; i--) {
    sensorIds.push(this.sensors[i]._id.toString());
  }

  return sensorIds;
};

boxSchema.methods.saveMeasurementsArray = function (measurements) {
  const box = this;

  if (!measurements || measurements.length === 0) {
    return Promise.reject('cannot save empty or invalid measurements');
  }

  if (!Array.isArray(measurements)) {
    return Promise.reject('array expected');
  }

  const sensorIds = this.sensorIds(),
    lastMeasurements = {};

  // check if all measurements belong to this box
  for (const measurement of measurements) {
    if (sensorIds.indexOf(measurement.sensor_id) === -1) {
      return Promise.reject(`measurement for sensor with id ${measurement.sensor_id} does not belong to box`);
    }

    if (!lastMeasurements[measurement.sensor_id]) {
      lastMeasurements[measurement.sensor_id] = measurement;
    } else {
      const ts = parseTimestamp(measurement.createdAt),
        previous_ts = parseTimestamp(lastMeasurements[measurement.sensor_id].createdAt);
      if (ts.isAfter(previous_ts)) {
        lastMeasurements[measurement.sensor_id] = measurement;
      }
    }
  }

  return Measurement.insertMany(measurements)
    .then(function () {
      // set lastMeasurementIds..
      for (const sensor of box.sensors) {
        if (lastMeasurements[sensor._id]) {
          sensor.lastMeasurement = lastMeasurements[sensor._id]._id;
        }
      }

      //save the box
      return box.save();
    });
};

boxSchema.methods.removeSelfAndMeasurements = function () {
  const box = this;

  return Measurement
    .find({ sensor_id: { $in: box.sensorIds() } })
    .remove()
    .then(function () {
      return box.remove();
    });
};

boxSchema.statics.findMeasurementsOfBoxesStream = function (opts) {
  const { query, from, to, columns, order, transformations } = opts;

  // find out which sensor property is wanted..
  let sensorProperty, phenomenon;
  if (!Object.keys(query).some(function (param) {
    if (param.startsWith('sensors.')) {
      phenomenon = query[param];
      sensorProperty = param.split('.').reverse()
        .shift();

      return true;
    }
  })) {
    return Promise.reject('missing sensor query');
  }

  return this.find(query)
    .lean()
    .exec()
    .then(function (boxData) {
      if (boxData.length === 0) {
        return Promise.reject('no senseBoxes found');
      }

      const sensors = Object.create(null);

      for (let i = 0, len = boxData.length; i < len; i++) {
        for (let j = 0, sensorslen = boxData[i].sensors.length; j < sensorslen; j++) {
          if (boxData[i].sensors[j][sensorProperty].toString() === phenomenon) {
            const sensor = boxData[i].sensors[j];

            sensor.lat = boxData[i].loc[0].geometry.coordinates[1];
            sensor.lon = boxData[i].loc[0].geometry.coordinates[0];
            sensor.boxId = boxData[i]._id.toString();
            sensor.boxName = boxData[i].name;
            sensor.exposure = boxData[i].exposure;
            sensor.sensorId = sensor._id.toString();
            sensor.phenomenon = sensor.title;

            sensors[boxData[i].sensors[j]['_id']] = sensor;
          }
        }
      }

      const transformer = transform(function (data) {
        const theData = {
          createdAt: data.createdAt,
          value: data.value
        };

        for (const col of columns) {
          if (!theData[col]) {
            theData[col] = sensors[data.sensor_id][col];
          }
        }

        if (transformations) {
          if (transformations.parseTimestamps) {
            theData.createdAt = parseTimestamp(data.createdAt);
          }

          if (transformations.parseAndStringifyTimestamps) {
            theData.createdAt = parseTimestamp(data.createdAt).toISOString();
          }

          if (transformations.stringifyTimestamps) {
            theData.createdAt = data.createdAt.toISOString();
          }

          if (transformations.parseValues) {
            theData.value = parseFloat(data.value);
          }
        }


        return theData;
      });

      transformer.on('error', function (err) {
        log.error(err);
        throw err;
      });

      return Measurement.find({
        'sensor_id': {
          '$in': Object.keys(sensors)
        },
        createdAt: {
          '$gt': from,
          '$lt': to
        }
      }, { 'createdAt': 1, 'value': 1, '_id': 0, 'sensor_id': 1 })
        .cursor({ lean: true, sort: order })
        .pipe(transformer);
    });
};

// try to add sensors defined in addons to the box. If the sensors already exist,
// nothing is done.
boxSchema.methods.addAddon = function addAddon (addon) {
  addon = addon.trim().toLowerCase();
  const addonSensors = sensorLayouts.getSensorsForAddon(addon);

  if (!addonSensors) {
    throw new Error('unknown Addon');
  }

  // store the model, we maybe need to change it for the generation of a new sketch
  const oldModel = this.model,
    allowedModelsForAddon = ['homeEthernet', 'homeWifi'],
    addonNameInModel = `${addon.charAt(0).toUpperCase()}${addon.slice(1)}`;

  // only proceed if the addon hasn't been applied before
  if (allowedModelsForAddon.includes(oldModel)) {
    for (const newSensor of addonSensors) {
      // only add new sensors if not already present
      if (!this.sensors.find(s => s.equals(newSensor))) {
        this.sensors.push(newSensor);
      }
    }

    // change model
    if (allowedModelsForAddon.includes(oldModel)) {
      this.set('model', `${oldModel}${addonNameInModel}`);
    }
  }
};

boxSchema.methods.addSensor = function addSensor ({ title, unit, sensorType, icon }) {
  this.sensors.push(new Sensor({ title, unit, sensorType, icon }));
};

boxSchema.methods.updateImage = function updateImage ({ type, data }) {
  if (type && data) {
    const extension = (type === 'image/jpeg') ? '.jpg' : '.png';
    fs.writeFileSync(`${imageFolder}${this._id}${extension}`, data);
    this.set('image', `${this._id}${extension}?${new Date().getTime()}`);
  }
};

boxSchema.methods.getSketch = function getSketch ({ encoding } = {}) {
  return templateSketcher.generateSketch(this, { encoding });
};

boxSchema.statics.findBoxByIdAndUpdate = function findBoxByIdAndUpdate (boxId, args) {
  const {
    mqtt: {
      enabled,
      url,
      topic,
      decodeOptions: mqttDecodeOptions,
      connectionOptions,
      messageFormat
    } = {},
    ttn: {
      app_id,
      dev_id,
      port,
      profile,
      decodeOptions: ttnDecodeOptions
    } = {},
    loc = {},
    sensors,
    addons: { add: addonToAdd } = {}
  } = args;


  if (sensors && addonToAdd) {
    return Promise.reject(new ModelError('sensors and addons can not appear in the same request.'));
  }

  let { lng, lat } = loc;
  if (lng && lat) {
    lng = parseFloat(lng);
    lat = parseFloat(lat);

    if (isNaN(lng) || isNaN(lat)) {
      return Promise.reject(new ModelError('Location invalid.'));
    }
    args['loc.0.geometry.coordinates'] = [lng, lat];
  }

  if (args.mqtt) {
    args['integrations.mqtt'] = { enabled, url, topic, decodeOptions: mqttDecodeOptions, connectionOptions, messageFormat };
  }
  if (args.ttn) {
    args['integrations.ttn'] = { app_id, dev_id, port, profile, decodeOptions: ttnDecodeOptions };
  }

  return this.findById(boxId)
    .then(function (box) {
      // only grouptag, description and weblink can removed through setting them to empty string ('')
      for (const prop of ['name', 'exposure', 'grouptag', 'description', 'weblink', 'image', 'loc.0.geometry.coordinates', 'integrations.mqtt', 'integrations.ttn']) {
        if (typeof args[prop] !== 'undefined') {
          box.set(prop, (args[prop] === '' ? undefined : args[prop]));
        }
      }

      if (sensors) {
        for (const { _id, title, unit, sensorType, icon, deleted, edited, new: isNew } of sensors) {
          const sensorIndex = box.sensors.findIndex(s => s._id.equals(_id));
          if (sensorIndex !== -1 && deleted) {
            box.sensors[sensorIndex].markForDeletion();
          } else if (edited && isNew && sensorIndex === -1) {
            box.addSensor({ _id, title, unit, sensorType, icon });
          } else if (sensorIndex !== -1 && edited && !deleted) {
            box.sensors.set(sensorIndex, { _id, title, unit, sensorType, icon });
          }
        }
      } else if (addonToAdd) {
        box.addAddon(addonToAdd);
      }

      return box.save();
    });
};

// add integrations Schema as box.integrations & register hooks
integrations.addToSchema(boxSchema);

const boxModel = mongoose.model('Box', boxSchema);

boxModel.BOX_PROPS_FOR_POPULATION = BOX_PROPS_FOR_POPULATION;
boxModel.BOX_SUB_PROPS_FOR_POPULATION = BOX_SUB_PROPS_FOR_POPULATION;
boxModel.BOX_VALID_MODELS = sensorLayouts.models;
boxModel.BOX_VALID_ADDONS = sensorLayouts.addons;

module.exports = {
  schema: boxSchema,
  model: boxModel
};
