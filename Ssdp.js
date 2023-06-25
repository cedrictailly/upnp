
const dgram        = require("dgram");
const util         = require("util");
const os           = require("os");
const EventEmitter = require("events").EventEmitter;
const ssdp         = exports;

// const ssdp = require("./classes/Ssdp").create();

// ssdp.on("ready", () => {
//   ssdp.search("urn:schemas-upnp-org:device:InternetGatewayDevice:1");
// });

// ssdp.on("device", ({headers, network}) => {
//   console.log("Found a gateway:", network, headers.location);
// });

class Ssdp extends EventEmitter {

  constructor(options = {}) {

    super();

    this.options = {
      multicast: "239.255.255.250",
      port     : 1900,
      ...options,
    };

    this.ready = false;

    let remaining = 0;

    const onSocketResponse = () => {

      remaining -= 1;

      if (remaining == 0) {
        this.ready = true;
        this.emit("ready");
      }
    };

    this.sockets = Object.entries(os.networkInterfaces()).map(
      ([name, addresses]) => addresses.filter(item => item.family === "IPv4").map(network => {

        const socket = dgram.createSocket("udp4");

        remaining += 1;

        socket.on("message", (message, info) => {

          message = message.toString();

          if (!/^(HTTP|NOTIFY)/m.test(message))
            return;

          const headers = Ssdp.parseMimeHeader(message);

          if (headers.st)
            this.emit("device", {headers, socket, network});
        });

        socket.on("listening", () => {
          this.emit("listening", socket);
          onSocketResponse();
        });

        socket.on("error", err => {
          this.emit("error", err);
          onSocketResponse();
        });

        socket.bind(0, network.address);

        return socket;
      }),
    ).flat();
  }

  static create() {
    return new Ssdp();
  }

  static parseMimeHeader(headers) {

    return headers.split(/\r\n/g).reduce((result, line) => {

      line.replace(/^([^:]*)\s*:\s*(.*)$/, (a, key, value) => {
        result[key.toLowerCase()] = value;
      });

      return result;

    }, {});
  }

  search(st, options = {}) {

    if (!this.ready)
      throw new Error("Not ready");

    options = {
      ...this.options,
      ...options,
    };

    const query = Buffer.from([
      "M-SEARCH * HTTP/1.1",
      "HOST: " + options.multicast + ":" + options.port + "",
      "MAN: \"ssdp:discover\"",
      "MX: 1",
      "ST: " + st + "",
      "",
    ].join("\r\n"));

    this.sockets.forEach(socket => {
      socket.send(query, 0, query.length, this.options.port, this.options.multicast);
    });
  }

  close() {

    this.sockets.forEach(socket => {
      socket.close();
    });

    this.ready = false;
  }
}

module.exports = Ssdp;
