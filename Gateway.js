
const axios     = require("axios");
const xml2js    = require("xml2js");
const xmlEscape = require("xml-escape");

const {EventEmitter} = require("events");
const {type}         = require("os");

function scanPort(port, host) {

  return new Promise((resolve, reject) => {

    const socket = new require("net").Socket();

    socket.setTimeout(1000);

    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });

    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

function parseDescription(info) {

  const result = {
    services: [],
    devices : [],
  };

  function traverseDevices(device) {

    if (typeof device != "object")
      return;

    if (device.serviceList)
      result.services.push(...device.serviceList.map(o => o.service || []).flat());

    if (device.deviceList) {

      const devices = device.deviceList.map(o => o.device || []).flat();

      result.devices.push(...devices);

      devices.forEach(traverseDevices);
    }
  }

  info.device.forEach(traverseDevices);

  for (const category in result) {
    result[category].forEach(item => {
      for (const name in item)
        item[name] = item[name][0];
    });
  }

  result.devices.forEach(device => {
    if (device.deviceList) device.deviceList = device.deviceList.device;
    if (device.serviceList) device.serviceList = device.serviceList.service;
  });

  return result;
}

class Gateway extends EventEmitter {

  constructor(url, network, services) {

    super();

    this.url      = url;
    this.network  = network;
    this.services = new Set(services || [
      "urn:schemas-upnp-org:service:WANIPConnection:1",
      "urn:schemas-upnp-org:service:WANPPPConnection:1",
    ]);

    url = new URL(this.url);

    this.host = url.hostname;
    this.port = url.port;
    this.info = null;

    axios.get(this.url).then(async response => {

      if (response.status !== 200) {
        this.emit("service-unavailable");
        return;
      }

      const root    = (await xml2js.parseStringPromise(response.data)).root;
      const service = parseDescription(root).services.filter(service => this.services.has(service.serviceType))[0];

      if (!service || !service.controlURL || !service.SCPDURL) {
        this.emit("service-unavailable");
        return;
      }

      const base = new URL(service.baseURL || url);

      this.info = {
        service   : service.serviceType,
        SCPDURL   : new URL(service.SCPDURL, base).href,
        controlURL: new URL(service.controlURL, base).href,
      };

      this.emit("ready");
    });
  }

  static listen(onGateway, options = {}) {

    options = {
      target  : "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
      services: null,
      timeout : null,
      ...options,
    };

    if (Gateway.ssdp)
      throw Error("Already listening");

    const ssdp     = Gateway.ssdp = require("./Ssdp").create();
    const gateways = Gateway.gateways = [];

    ssdp.on("ready", () => {
      ssdp.search(options.target);
    });

    ssdp.on("device", async ({headers, network}) => {

      const gateway = new Gateway(headers.location, network, options.services);

      gateway.once("ready", () => {
        Gateway.gateways.push(gateway);
        onGateway(gateway);
      });
    });

    const close = () => ssdp.close();

    const tid = typeof options.timeout != "number" ? null : setTimeout(close, options.timeout);

    return {ssdp, gateways, tid, close};
  }

  static close() {

    if (!Gateway.ssdp)
      throw Error("Not listening");

    Gateway.ssdp.close();

    Gateway.ssdp     = null;
    Gateway.gateways = [];
  }

  async call(action, args) {

    args = args.map(arg => {

      const result = ["<" + arg[0] + ">", "</" + arg[0] + ">"];

      if (arg[1] !== undefined)
        result.splice(1, 0, xmlEscape(arg[1].toString()));

      return result.join("");
    });

    const body = [
      "<?xml version=\"1.0\"?>",
      "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">",
      "<s:Body>",
      "<u:" + action + " xmlns:u=" + JSON.stringify(this.info.service) + ">",
      ...args,
      "</u:" + action + ">",
      "</s:Body>",
      "</s:Envelope>",
    ].join("");

    let response;

    try {

      response = await axios.post(this.info.controlURL, body, {
        headers: {
          "Content-Type"  : "text/xml; charset=\"utf-8\"",
          "Content-Length": Buffer.byteLength(body),
          "SOAPAction"    : JSON.stringify(this.info.service + "#" + action),
        },
      });

    } catch (error) {

      const data      = await xml2js.parseStringPromise(error.response.data);
      const upnpError = data["s:Envelope"]["s:Body"][0]["s:Fault"][0]["detail"][0]["UPnPError"][0];

      throw new Error(upnpError["errorDescription"][0], {
        cause: {
          gateway         : this,
          request         : body,
          response        : error.response.data,
          errorCode       : upnpError["errorCode"][0],
          errorDescription: upnpError["errorDescription"][0],
          axiosError      : error,
        },
      });
    }

    if (response.status !== 200)
      throw new Error("Failed to run action");

    response.data = await xml2js.parseStringPromise(response.data);
    response.data = response.data["s:Envelope"]["s:Body"][0]["u:" + action + "Response"][0];

    const result = {};

    for (const name in response.data) {
      if (Array.isArray(response.data[name]))
        result[name] = response.data[name][0];
    }

    return result;
  }

  async getMappings() {

    const result = [];

    for (let i = 0; i < Infinity; i++) {

      let res;

      try {

        res = await this.call("GetGenericPortMappingEntry", [
          ["NewPortMappingIndex", i],
        ]);

      } catch (err) {
        break;
      }

      result.push({
        "public": {
          host: typeof res.NewRemoteHost === "string" && res.NewRemoteHost || "",
          port: parseInt(res.NewExternalPort, 10),
        },
        "private": {
          host: res.NewInternalClient,
          port: parseInt(res.NewInternalPort, 10),
        },
        "protocol"   : res.NewProtocol.toLowerCase(),
        "enabled"    : res.NewEnabled === "1",
        "description": res.NewPortMappingDescription,
        "ttl"        : parseInt(res.NewLeaseDuration, 10),
      });
    }

    return result;
  }

  async addMapping(internalPort, remotePort, options = {}) {

    let ttl = 60 * 30;

    options = {
      internalHost: this.network.address,
      remoteHost  : "",
      protocol    : "TCP",
      description : "zag:upnp",
      portScan    : true,
      ...options,
    };

    if (options.portScan && !await scanPort(internalPort, options.internalHost))
      throw new Error(`Internal port ${internalPort} is not open`);

    if (typeof options.ttl == "number")
      ttl = options.ttl;
    else if (typeof options.ttl == "string" && !isNaN(options.ttl))
      ttl = Number(options.ttl);

    return await this.call("AddPortMapping", [
      ["NewInternalPort", internalPort],
      ["NewInternalClient", options.internalHost],
      ["NewExternalPort", remotePort],
      ["NewRemoteHost", options.remoteHost],
      ["NewProtocol", options.protocol.toUpperCase()],
      ["NewEnabled", 1],
      ["NewPortMappingDescription", options.description],
      ["NewLeaseDuration", ttl],
    ]);
  }

  async deleteMapping(internalPort, remotePort, options = {}) {

    options = {
      internalHost: this.network.address,
      externalHost: "",
      protocol    : "TCP",
      description : "zag:upnp",
      ...options,
    };

    await this.call("DeletePortMapping", [
      ["NewInternalPort", internalPort],
      ["NewInternalClient", options.internalHost],
      ["NewExternalPort", remotePort],
      ["NewRemoteHost", options.remoteHost],
      ["NewProtocol", options.protocol?.toUpperCase()],
    ]);
  }

  async getExternalIp() {
    return (await this.call("GetExternalIPAddress", [])).NewExternalIPAddress;
  }
}

module.exports = Gateway;
