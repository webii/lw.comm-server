"use strict";
/*

    AUTHOR:  Claudio Prezzi github.com/cprezzi

    THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
    WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
    MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
    ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
    WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
    ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
    OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.

*/

const config = require('./config');
const serialport = require('serialport');
var SerialPort = serialport;
const Readline = SerialPort.parsers.Readline;
const websockets = require('socket.io');
const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const os = require('os');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const nstatic = require('node-static');
const url = require('url');
const util = require('util');
const chalk = require('chalk');
const request = require('request'); // proxy for remote webcams
const grblStrings = require('./grblStrings.js');
const firmwareFeatures = require('./firmwareFeatures.js');
const { exec } = require('child_process'); //Support for running OS commands before and after jobs

exports.LWCommServer=function(config){

    let logFile;
    let connectionType, connections = [];
    const gcodeQueue = [];
    let port, parser, isConnected, connectedTo, portsList;
    let machineSocket, connectedIp;
    let buffer;

    let statusLoop, queueCounter, listPortsLoop = false;
    let paused = false, blocked = false;

    let firmware, fVersion, fDate;
    let feedOverride = 100;
    let spindleOverride = 100;
    let laserTestOn = false;

    let runningJob;
    let startTime;
    let queuePointer = 0;

    const optimizeGcode = false;

    var supportedInterfaces = ['USB', 'ESP8266', 'Telnet'];

    var GRBL_RX_BUFFER_SIZE = config.grblBufferSize;            // max. chars (default: 128)
    var grblBufferSize = [];
    const new_grbl_buffer = false;

    const SMOOTHIE_RX_BUFFER_SIZE = config.smoothieBufferSize;    // max. length of one command line (default: 64)
    const smoothie_buffer = false;
    let lastMode;

    const TINYG_RX_BUFFER_SIZE = config.tinygBufferSize;          // max. lines of gcode to send before wait for ok (default: 24)
    let tinygBufferSize = TINYG_RX_BUFFER_SIZE;                 // init space left

    let REPRAP_RX_BUFFER_SIZE = config.reprapBufferSize;        // max. lines of gcode to send before wait for ok (default: 2)
    let reprapBufferSize = REPRAP_RX_BUFFER_SIZE;               // init space left
    let reprapWaitForPos = false;

    let xPos = 0.00, yPos = 0.00, zPos = 0.00, aPos = 0.00;
    let xOffset = 0.00, yOffset = 0.00, zOffset = 0.00, aOffset = 0.00;
    let has4thAxis = false;

    const jsonStatus = ['Init', 'Idle', 'Alarm', 'Idle', 'Idle', 'Run', 'Hold', 'Probe', 'Run', 'Home'];

    function parseFloatToFixed(val) {
        return parseFloat(val).toFixed(config.posDecimals);
    }

    function arrayToPoint(arr) {
        if (xPos !== parseFloatToFixed(arr[0])) {
            xPos = parseFloatToFixed(arr[0]);
        }
        if (yPos !== parseFloatToFixed(arr[1])) {
            yPos = parseFloatToFixed(arr[1]);
        }
        if (zPos !== parseFloatToFixed(arr[2])) {
            zPos = parseFloatToFixed(arr[2]);
        }

        var point = {x: xPos, y: yPos, z: zPos};

        if (arr.length > 3) {
            if (aPos !== parseFloatToFixed(arr[3])) {
                aPos = parseFloatToFixed(arr[3]);
                has4thAxis = true;
            }
        }

        if (has4thAxis) {
            point['a'] = aPos;
        }

        return point;
    }

    function getConnectionStatus(appSocket) {
        if (isConnected) {
            appSocket.emit('activeInterface', connectionType);
            switch (connectionType) {
                case 'usb':
                    appSocket.emit('activePort', port.path);
                    appSocket.emit('activeBaudRate', port.settings.baudRate);
                    break;
                case 'telnet':
                case 'esp8266':
                    appSocket.emit('activeIP', connectedTo);
                    break;
            }
            appSocket.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
            if (port) {
                appSocket.emit('connectStatus', 'opened:' + port.path);
            } else {
                appSocket.emit('connectStatus', 'opened:' + connectedTo);
            }
        } else {
            appSocket.emit('connectStatus', 'Connect');
        }
    }

    function errorOnMissingConnection() {
        websocket.sockets.emit("connectStatus", 'closed');
        websocket.sockets.emit('connectStatus', 'Connect');
        writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
    }

    function closeConnection() {
        clearInterval(queueCounter);
        clearInterval(statusLoop);
        gcodeQueue.length = 0; // dump the queye
        grblBufferSize.length = 0; // dump bufferSizes
        tinygBufferSize = TINYG_RX_BUFFER_SIZE; // reset tinygBufferSize
        reprapBufferSize = REPRAP_RX_BUFFER_SIZE; // reset reprapBufferSize
        reprapWaitForPos = false;
        websocket.sockets.emit("connectStatus", 'closed:');
        websocket.sockets.emit("connectStatus", 'Connect');
        isConnected = false;
        connectedTo = false;
        firmware = false;
        paused = false;
        blocked = false;
    }

    function errorOnNoSupportedFirmware() {
        writeLog('No supported firmware detected.', 1);
        websocket.sockets.emit('data', 'No supported firmware detected.');
        closeConnection();
    }

    function dataParserWPos(data) {
        // Extract wPos (for Grbl > 1.1 only!)
        const startWPos = data.search(/wpos:/i) + 5;
        let wPos;
        if (startWPos > 5) {
            const wPosLen = data.substr(startWPos).search(/>|\|/);
            wPos = data.substr(startWPos, wPosLen).split(/,/);
        }
        if (Array.isArray(wPos)) {
            websocket.sockets.emit('wPos', arrayToPoint(wPos));
        }
    }

    function dataParserMPos(data) {
        var startMPos = data.search(/mpos:/i) + 5;
        var mPos;
        if (startMPos > 5) {
            mPos = data.replace('>', '').substr(startMPos).split(/,|\|/, 4);
        }
        if (Array.isArray(mPos)) {
            var send = false;
            if (xOffset !== parseFloatToFixed(mPos[0]) - xPos) {
                xOffset = parseFloatToFixed(mPos[0]) - xPos;
                send = true;
            }
            if (yOffset !== parseFloatToFixed(mPos[1]) - yPos) {
                yOffset = parseFloatToFixed(mPos[1]) - yPos;
                send = true;
            }
            if (zOffset !== parseFloatToFixed(mPos[2]) - zPos) {
                zOffset = parseFloatToFixed(mPos[2]) - zPos;
                send = true;
            }
            if (aOffset !== parseFloatToFixed(mPos[3])- aPos) {
                aOffset = parseFloatToFixed(mPos[3])- aPos;
                send = true;
            }
            if (send) {
                websocket.sockets.emit('wOffset', {x: xOffset, y: yOffset, z: zOffset, a: aOffset});
            }
        }
    }

    function dataParserWorkOffset(data) {
        // Extract work offset (for Grbl > 1.1 only!)
        var startWCO = data.search(/wco:/i) + 4;
        var wco;
        if (startWCO > 4) {
            wco = data.replace('>', '').substr(startWCO).split(/,|\|/, 4);
        }
        if (Array.isArray(wco)) {
            websocket.sockets.emit('wOffset', arrayToPoint(wco));
        }
    }

    function dataParserOverrideValues(data) {
        // Extract override values (for Grbl > v1.1 only!)
        var startOv = data.search(/ov:/i) + 3;
        if (startOv > 3) {
            var ov = data.replace('>', '').substr(startOv).split(/,|\|/, 3);
            if (Array.isArray(ov)) {
                if (ov[0]) {
                    websocket.sockets.emit('feedOverride', ov[0]);
                }
                if (ov[1]) {
                    websocket.sockets.emit('rapidOverride', ov[1]);
                }
                if (ov[2]) {
                    websocket.sockets.emit('spindleOverride', ov[2]);
                }
            }
        }
    }

    function dataParserFeedAndSpindle(data) {
        // Extract realtime Feed and Spindle (for Grbl > v1.1 only!)
        const startFS = data.search(/FS:/i) + 3;
        if (startFS > 3) {
            const fs = data.replace('>', '').substr(startFS).split(/,|\|/, 2);
            if (Array.isArray(fs)) {
                if (fs[0]) {
                    websocket.sockets.emit('realFeed', fs[0]);
                }
                if (fs[1]) {
                    websocket.sockets.emit('realSpindle', fs[1]);
                }
            }
        }
    }

    function dataParserGrblFirmware(data) {
        firmware = 'grbl';
        fVersion = data.substr(5, 4); // get version
        fDate = '';
        writeLog('GRBL detected (' + fVersion + ')', 1);
        websocket.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
        // Start intervall for status queries
        statusLoop = setInterval(function () {
            if (isConnected) {
                machineSend('?');
                //writeLog('Sent: ?', 2);
            }
        }, 250);
    }

    function dataParserSmoothieFirmware(data) {
        firmware = 'smoothie';
        //SMOOTHIE_RX_BUFFER_SIZE = 64;  // max. length of one command line
        var startPos = data.search(/version:/i) + 9;
        fVersion = data.substr(startPos).split(/,/, 1);
        startPos = data.search(/Build date:/i) + 12;
        fDate = new Date(data.substr(startPos).split(/,/, 1));
        var dateString = fDate.toDateString();
        writeLog('Smoothieware detected (' + fVersion + ', ' + dateString + ')', 1);
        websocket.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});

        // Start interval for status queries
        statusLoop = setInterval(function () {
            if (isConnected) {
                machineSend('?');
            }
        }, 250);
    }

    function setLoopForStatusQueries() {
        statusLoop = setInterval(function () {
            if (isConnected) {
                if (!reprapWaitForPos && reprapBufferSize >= 0) {
                    reprapWaitForPos = true;
                    machineSend('M114\n'); // query position
                    reprapBufferSize--;
                    writeLog('Sent: M114 (B' + reprapBufferSize + ')', 2);
                }
            }
        }, 250);
    }


    function dataParserMarlinFirmware(data) {
        firmware = 'marlin';
        var startPos = data.search(/marlin_/i) + 7;
        fVersion = data.substr(startPos, 5); // get version
        fDate = '';
        writeLog('Marlin detected (' + fVersion + ')', 1);
        websocket.sockets.emit('firmware', { firmware: firmware, version: fVersion, date: fDate });
        setLoopForStatusQueries();
    }

    function dataParserMarlinKimbra(data) {
        firmware = 'marlinkimbra';
        var startPos = data.search(/mk_/i) + 3;
        fVersion = data.substr(startPos, 5); // get version
        fDate = '';
        writeLog('MarlinKimbra detected (' + fVersion + ')', 1);
        websocket.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
        setLoopForStatusQueries();
    }

    function dataParserRepetierFirmware(data) {
        firmware = 'repetier';
        var startPos = data.search(/repetier_/i) + 9;
        fVersion = data.substr(startPos, 4); // get version
        fDate = '';
        writeLog('Repetier detected (' + fVersion + ')', 1);
        websocket.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
        // Start intervall for status queries
        setLoopForStatusQueries();
    }

    function dataParserRepRapFirmware(data) {
        firmware = 'reprapfirmware';
        var startPos = data.search(/firmware_version:/i) + 18;
        fVersion = data.substr(startPos, 7); // get version
        startPos = data.search(/firmware_date:/i) + 16;
        fDate = new Date(data.substr(startPos, 12));
        REPRAP_RX_BUFFER_SIZE = 5;
        reprapBufferSize = REPRAP_RX_BUFFER_SIZE;
        writeLog('RepRapFirmware detected (' + fVersion + ')', 1);
        websocket.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
        setLoopForStatusQueries();
    }

    function dataParseJsonData(data) {
        var jsObject = JSON.parse(data);

        if (jsObject.hasOwnProperty('r')) {
            var footer = jsObject.f || (jsObject.r && jsObject.r.f);
            var responseText;
            if (footer !== undefined) {
                if (footer[1] === 108) {
                    responseText = util.format("TinyG reported an syntax error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]);
                    websocket.sockets.emit('data', responseText);
                    writeLog("Response: " + responseText + jsObject, 3);
                } else if (footer[1] === 20) {
                    responseText = util.format("TinyG reported an internal error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]);
                    websocket.sockets.emit('data', responseText);
                    writeLog("Response: " + responseText + jsObject, 3);
                } else if (footer[1] === 202) {
                    responseText = util.format("TinyG reported an TOO SHORT MOVE on line %d", jsObject.r.n);
                    websocket.sockets.emit('data', responseText);
                    writeLog("Response: " + responseText + jsObject, 3);
                } else if (footer[1] === 204) {
                    responseText = util.format("TinyG reported COMMAND REJECTED BY ALARM '%s'", JSON.stringify(jsObject.r));
                    websocket.sockets.emit('data', responseText);
                    writeLog("InAlarm: " + responseText + jsObject, 3);
                } else if (footer[1] !== 0) {
                    responseText = util.format("TinyG reported an error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]);
                    websocket.sockets.emit('data', responseText);
                    writeLog("Response: " + responseText + jsObject, 3);
                } else {
                    //websocket.sockets.emit('data', data);
                }
            }
            //writeLog('Response: ' + JSON.stringify(jsObject.r) + ', ' + footer, 3);
            jsObject = jsObject.r;

            tinygBufferSize++;
            blocked = false;
            send1Q();
        }

        if (jsObject.hasOwnProperty('sr')) {    // status report
            //writeLog('statusChanged ' + JSON.stringify(jsObject.sr), 3);
            var send = false;
            if (jsObject.sr.posx != null) {
                xPos = parseFloatToFixed(jsObject.sr.posx)
                send = true;
            }
            if (jsObject.sr.posy != null) {
                yPos = parseFloatToFixed(jsObject.sr.posy)
                send = true;
            }
            if (jsObject.sr.posz != null) {
                zPos = parseFloatToFixed(jsObject.sr.posz)
                send = true;
            }
            if (jsObject.sr.posa != null) {
                aPos = parseFloatToFixed(jsObject.sr.posa)
                send = true;
            }
            if (send) {
                websocket.sockets.emit('wPos', {x: xPos, y: yPos, z: zPos, a: aPos});
            }

            if (jsObject.sr.stat && parseInt(jsObject.sr.stat, 10) >= 0) {
                websocket.sockets.emit('data', '<' + jsonStatus[parseInt(jsObject.sr.stat, 10)] + ',>');
            }
        }
        if (jsObject.hasOwnProperty('fb')) {    // firmware
            firmware = 'tinyg';
            fVersion = jsObject.fb;
            fDate = '';
            writeLog('TinyG detected (' + fVersion + ')', 1);
            websocket.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
            // Start intervall for status queries
//                            statusLoop = setInterval(function () {
//                                if (isConnected) {
//                                    machineSend('{sr:n}\n');
//                                    //writeLog('Sent: {"sr":null}', 2);
//                                }
//                            }, 250);
        }
        if (jsObject.hasOwnProperty('gc')) {
            writeLog('gcodeReceived ' + jsObject.r.gc, 3);
            websocket.sockets.emit('data', data);
        }
        if (jsObject.hasOwnProperty('rx')) {
            writeLog('rxReceived ' + jsObject.r.rx, 3);
            websocket.sockets.emit('data', data);
        }
        if (jsObject.hasOwnProperty('er')) {
            writeLog('errorReport ' + jsObject.er, 3);
            websocket.sockets.emit('data', data);
        }
        //websocket.sockets.emit('data', data);
    }

    function dataParser(data) {

        let startPos;
        writeLog('Recv: ' + data, 3);

        if (data.startsWith('ok')) { // Got an OK so we are clear to send
            if (firmware === 'grbl') {
                grblBufferSize.shift();
            }
            if (firmware === 'repetier' || firmware === 'marlinkimbra' || firmware === 'marlin' || firmware === 'reprapfirmware') {
                reprapBufferSize++;
            }
            blocked = false;
            send1Q();
        } else if (data.startsWith('<')) { // Got statusReport (Grbl & Smoothieware)
            websocket.sockets.emit('data', data);

            if (firmware == 'grbl') {
                dataParserMPos(data);
                dataParserWorkOffset(data);
            }
            if (firmware == 'smoothie') {
                // Extract wPos and mPos (for Smoothieware only!)
                dataParserWPos(data);
                dataParserMPos(data);
            }

            dataParserOverrideValues(data);
            dataParserFeedAndSpindle(data);

        } else if (data.indexOf('X') === 0) {   // Extract wPos for RepRap (Repetier, Marlin, MK, RepRapFirmware)
            let pos;
            startPos = data.search(/x:/i) + 2;
            if (startPos >= 2) {
                pos = data.substr(startPos, 4);
                if (xPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                    xPos = parseFloat(pos).toFixed(config.posDecimals);
                }
            }
            startPos = data.search(/y:/i) + 2;
            if (startPos >= 2) {
                pos = data.substr(startPos, 4);
                if (yPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                    yPos = parseFloat(pos).toFixed(config.posDecimals);
                }
            }
            startPos = data.search(/z:/i) + 2;
            if (startPos >= 2) {
                pos = data.substr(startPos, 4);
                if (zPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                    zPos = parseFloat(pos).toFixed(config.posDecimals);
                }
            }
            startPos = data.search(/e:/i) + 2;
            if (startPos >= 2) {
                pos = data.substr(startPos, 4);
                if (aPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                    aPos = parseFloat(pos).toFixed(config.posDecimals);
                }
            }
            websocket.sockets.emit('wPos', {x: xPos, y: yPos, z: zPos, a: aPos});

            if (firmware === 'reprapfirmware') {
                //reprapBufferSize++;
            }
            reprapWaitForPos = false;

        } else if (data.indexOf('WCS:') >= 0) {
            //console.log('Telnet:', response);
            // IN: "last C: X:0.0000 Y:-0.0000 Z:0.0000 realtime WCS: X:0.0000 Y:0.0045 Z:0.0000 MCS: X:44.2000 Y:76.5125 Z:0.0000 APOS: X:44.2000 Y:76.5125 Z:0.0000 MP: X:44.2000 Y:76.5080 Z:0.0000 CMP: X:44.2000 Y:76.5080 Z:0.0000"
            // OUT: "<Run,MPos:49.5756,279.7644,-15.0000,WPos:0.0000,0.0000,0.0000>"
            startPos = data.search(/wcs: /i) + 5;
            var wpos;
            if (startPos > 5) {
                wpos = data.substr(startPos).split(/:| /, 6);
            }
            if (Array.isArray(wpos)) {
                writeLog('Telnet: ' + 'WPos:' + wpos, 1);
                websocket.sockets.emit('wPos', arrayToPoint(wpos));
            }
        } else if (data.indexOf('MCS:') >= 0) {
            //console.log('Telnet:', response);
            // IN: "last C: X:0.0000 Y:-0.0000 Z:0.0000 realtime WCS: X:0.0000 Y:0.0045 Z:0.0000 MCS: X:44.2000 Y:76.5125 Z:0.0000 APOS: X:44.2000 Y:76.5125 Z:0.0000 MP: X:44.2000 Y:76.5080 Z:0.0000 CMP: X:44.2000 Y:76.5080 Z:0.0000"
            // OUT: "<Run,MPos:49.5756,279.7644,-15.0000,WPos:0.0000,0.0000,0.0000>"
            startPos = data.search(/mcs: /i) + 5;
            var mpos;
            if (startPos > 5) {
                mpos = data.substr(startPos).split(/:| /, 6);
            }
            if (Array.isArray(mpos)) {
                writeLog('Telnet: ' + 'MPos:' + mpos, 1);
                websocket.sockets.emit('mPos', arrayToPoint(mpos));
            }
        } else if (data.indexOf('Grbl') === 0) { // Check if it's Grbl
            dataParserGrblFirmware(data)
        } else if (data.indexOf('LPC176') >= 0) { // LPC1768 or LPC1769 should be Smoothie
            dataParserSmoothieFirmware(data);
        } else if (data.indexOf('start') === 0) { // Check if it's RepRap
            machineSend('M115\n'); // Check if it's Repetier or MarlinKimbra
            reprapBufferSize--;
            writeLog('Sent: M115', 2);
        } else if (data.indexOf('FIRMWARE_NAME:Repetier') >= 0) { // Check if it's Repetier
            dataParserRepetierFirmware(data);
        } else if (data.indexOf('FIRMWARE_NAME:Marlin') >= 0) { // Check if it's MarlinKimbra
            dataParserMarlinFirmware(data)
        } else if (data.indexOf('FIRMWARE_NAME:MK') >= 0) { // Check if it's MarlinKimbra
            dataParserMarlinKimbra(data)
        } else if (data.indexOf('FIRMWARE_NAME: RepRapFirmware') >= 0) { // Check if it's RepRapFirmware
            dataParserRepRapFirmware(data);
        } else if (data.indexOf('{') === 0) { // JSON response (probably TinyG)
            dataParseJsonData(data);
        } else if (data.indexOf('ALARM') === 0) { //} || data.indexOf('HALTED') === 0) {
            switch (firmware) {
                case 'grbl':
                    grblBufferSize.shift();
                    var alarmCode = parseInt(data.split(':')[1]);
                    writeLog('ALARM: ' + alarmCode + ' - ' + grblStrings.alarms(alarmCode));
                    websocket.sockets.emit('data', 'ALARM: ' + alarmCode + ' - ' + grblStrings.alarms(alarmCode));
                    break;
                case 'smoothie':
                case 'tinyg':
                case 'repetier':
                case 'marlinkimbra':
                case 'marlin':
                case 'reprapfirmware':
                    websocket.sockets.emit('data', data);
                    break;
            }
        } else if (data.indexOf('wait') === 0) { // Got wait from Repetier -> ignore
            // do nothing
        } else if (data.indexOf('Resend') === 0) { // Got resend from Repetier -> TODO: resend corresponding line!!!
            switch (firmware) {
                case 'repetier':
                case 'marlinkimbra':
                case 'marlin':
                case 'reprapfirmware':
                    break;
            }
        } else if (data.indexOf('error') === 0) { // Error received -> stay blocked stops queue
            switch (firmware) {
                case 'grbl':
                    grblBufferSize.shift();
                    var errorCode = parseInt(data.split(':')[1]);
                    writeLog('error: ' + errorCode + ' - ' + grblStrings.errors(errorCode));
                    websocket.sockets.emit('data', 'error: ' + errorCode + ' - ' + grblStrings.errors(errorCode));
                    break;
                case 'smoothie':
                case 'tinyg':
                case 'repetier':
                case 'marlinkimbra':
                case 'marlin':
                case 'reprapfirmware':
                    websocket.sockets.emit('data', data);
                    break;
            }
        } else if (data === ' ') {
            // nothing
        } else {
            websocket.sockets.emit('data', data);
        }
    }

    function homeAxis(axis) {
        switch (firmware) {
            case 'smoothie':
            case 'repetier':
            case 'marlinkimbra':
                addQ('G28.2 ' + axis);
                break;
            case 'tinyg':
                addQ('G28.2 ' + axis + '0');
                break;
            case 'marlin':
            case 'reprapfirmware':
                addQ('G28 ' + axis);
                break;
            default:
                //not supported
                appSocket.emit('error', 'Command not supported by firmware!');
                break;
        }
    }

    function laserTest(power, gCodesBefore, gCodesAfter, isTurningOff = true) {
        var gcode;

        for (gcode of gCodesBefore) {
            addQ(gcode);
        }

        laserTestOn = true;
        appSocket.emit('laserTest', power);
        if (duration > 0) {
            for (gcode of gCodesAfter) {
                addQ(gcode);
            }

            if (isTurningOff) {
                setTimeout(function () {
                    laserTestOn = false;
                    appSocket.emit('laserTest', 0);
                }, duration);
            }
        }
    }

    dns.lookup(os.hostname(), function (err, add, fam) {
        writeLog(chalk.green(' '), 0);
        writeLog(chalk.green('***************************************************************'), 0);
        writeLog(chalk.white('        ---- LaserWeb Comm Server ' + config.serverVersion + ' ----        '), 0);
        writeLog(chalk.green('***************************************************************'), 0);
        writeLog(chalk.white('  Use ') + chalk.yellow(' http://' + add + ':' + config.webPort) + chalk.white(' to connect this server.'), 0);
        writeLog(chalk.green('***************************************************************'));
        writeLog(chalk.green(' '), 0);
        writeLog(chalk.red('* Updates: '), 0);
        writeLog(chalk.green('  Remember to check the commit log on'), 0);
        writeLog(chalk.yellow('  https://github.com/LaserWeb/lw.comm-server/commits/master'), 0);
        writeLog(chalk.green('  regularly, to know about updates and fixes, and then when ready'), 0);
        writeLog(chalk.green('  update accordingly by running ') + chalk.cyan('git pull'), 0);
        writeLog(chalk.green(' '), 0);
        writeLog(chalk.red('* Support: '), 0);
        writeLog(chalk.green('  If you need help / support, come over to '), 0);
        writeLog(chalk.green('  ') + chalk.yellow('https://forum.makerforums.info/c/laserweb-cncweb/78'), 0);
        writeLog(chalk.green('***************************************************************'), 0);
        writeLog(chalk.green(' '), 0);
    });


// Init webserver
    var webServer = new nstatic.Server(config.uipath || path.join(__dirname, '/app'));
    var app = http.createServer(function (req, res) {
        var queryData = url.parse(req.url, true).query;
        if (queryData.url && queryData.url !== '') {
            request({
                url: queryData.url, // proxy for remote webcams
                callback: function (err, res, body) {
                    if (err) {
                        // writeLog(err)
                        console.error(chalk.red('ERROR:'), chalk.yellow(' Remote Webcam Proxy error: '), chalk.white('"' + queryData.url + '"'), chalk.yellow(' is not a valid URL: '));
                    }
                }
            }).on('error', function (e) {
                res.end(e);
            }).pipe(res);
        } else {
            webServer.serve(req, res, function (err, result) {
                if (err) {
                    console.error(chalk.red('ERROR:'), chalk.yellow(' webServer error:' + req.url + ' : '), err.message);
                }
            });
        }
    });
    app.listen(config.webPort, config.IP);
    var websocket = websockets.listen(app);


// WebSocket connection from frontend
    websocket.sockets.on('connection', function (appSocket) {

        // save new connection
        connections.push(appSocket);
        writeLog(chalk.yellow('App connected! (id=' + connections.indexOf(appSocket) + ')'), 1);

        // send supported interfaces
        appSocket.emit('interfaces', supportedInterfaces);

        // check available ports
        serialport.list(function (err, ports) {
            portsList = ports;
            appSocket.emit('ports', portsList);
        });
        // recheck ports every 2s
        if (!listPortsLoop) {
            listPortsLoop = setInterval(function () {
                serialport.list(function (err, ports) {
                    if (JSON.stringify(ports) != JSON.stringify(portsList)) {
                        portsList = ports;
                        websocket.sockets.emit('ports', ports);
                        writeLog(chalk.yellow('Ports changed: ' + JSON.stringify(ports)), 1);
                    }
                });
            }, 2000);
        }

        if (isConnected) {
            appSocket.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
            if (port) {
                appSocket.emit('connectStatus', 'opened:' + port.path);
                appSocket.emit('activePort', port.path);
                appSocket.emit('activeBaudRate', port.settings.baudRate);
            } else {
                appSocket.emit('connectStatus', 'opened:' + connectedTo);
                appSocket.emit('activeIP', connectedTo);
            }
            if (runningJob) {
                appSocket.emit('runningJob', runningJob);
            }
        } else {
            appSocket.emit('connectStatus', 'Connect');
        }

        appSocket.on('firstLoad', function () {
            writeLog(chalk.yellow('INFO: ') + chalk.blue('FirstLoad called'), 1);
            appSocket.emit('serverConfig', config);
            appSocket.emit('interfaces', supportedInterfaces);
            serialport.list(function (err, ports) {
                appSocket.emit('ports', ports);
            });
            getConnectionStatus(appSocket);
        });

        appSocket.on('getServerConfig', function () { // Deliver config of server (incl. versions)
            writeLog(chalk.yellow('INFO: ') + chalk.blue('Requesting Server Config '), 1);
            appSocket.emit('serverConfig', config);
        });

        appSocket.on('getInterfaces', function () { // Deliver supported Interfaces
            writeLog(chalk.yellow('INFO: ') + chalk.blue('Requesting Interfaces '), 1);
            appSocket.emit('interfaces', supportedInterfaces);
        });

        appSocket.on('getPorts', function () { // Refresh serial port list
            writeLog(chalk.yellow('INFO: ') + chalk.blue('Requesting Ports list '), 1);
            serialport.list(function (err, ports) {
                appSocket.emit('ports', ports);
            });
        });

        appSocket.on('getConnectStatus', function () { // Report active serial port to web-client
            writeLog(chalk.yellow('INFO: ') + chalk.blue('getConnectStatus'), 1);
            getConnectionStatus(appSocket);
        });

        appSocket.on('getFirmware', function (data) { // Deliver Firmware to Web-Client
            appSocket.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
        });

        appSocket.on('getFeatureList', function (data) { // Deliver supported Firmware Features to Web-Client
            appSocket.emit('featureList', firmwareFeatures.get(firmware));
        });

        appSocket.on('getRunningJob', function (data) { // Deliver running Job to Web-Client
            appSocket.emit('runningJob', runningJob);
        });

        appSocket.on('connectTo', function (data) { // If a user picks a port to connect to, open a Node SerialPort Instance to it
            data = data.split(',');
            writeLog(chalk.yellow('INFO: ') + chalk.blue('Connecting to ' + data), 1);
            if (!isConnected) {
                connectionType = data[0].toLowerCase();
                firmware = false;
                switch (connectionType) {
                    case 'usb':
                        port = new SerialPort(data[1], {
                            baudRate: parseInt(data[2].replace('baud',''))
                        });
                        parser = new Readline({ delimiter: '\n' });
                        port.pipe(parser);
                        websocket.sockets.emit('connectStatus', 'opening:' + port.path);

                        // Serial port events -----------------------------------------------
                        port.on('open', function () {
                            websocket.sockets.emit('activePort', {port: port.path, baudrate: port.settings.baudRate});
                            websocket.sockets.emit('connectStatus', 'opened:' + port.path);
                            if (config.resetOnConnect == 1) {
                                port.write(String.fromCharCode(0x18)); // ctrl-x (needed for rx/tx connection)
                                writeLog('Sent: ctrl-x', 1);
                            } else {
                                machineSend('\n'); // this causes smoothie to send the welcome string
                            }
                            setTimeout(function () { //wait for controller to be ready
                                if (!firmware) { // Grbl should be already detected
                                    machineSend('version\n'); // Check if it's Smoothieware?
                                    writeLog('Sent: version', 2);
                                    setTimeout(function () {  // Wait for Smoothie to answer
                                        if (!firmware) {     // If still not set
                                            machineSend('{fb:n}\n'); // Check if it's TinyG
                                            writeLog('Sent: {fb:n}', 2);
                                            setTimeout(function () {  // Wait for TinyG to answer
                                                if (!firmware) {     // If still not set
                                                    machineSend('M115\n'); // Check if it's Repetier, Marlin, MK, RepRap
                                                    reprapBufferSize--;
                                                    writeLog('Sent: M115', 2);
                                                }
                                            }, config.tinygWaitTime * 1000);
                                        }
                                    }, config.smoothieWaitTime * 1000);
                                }
                            }, config.grblWaitTime * 1000);
                            if (config.firmwareWaitTime > 0) {
                                setTimeout(function () {
                                    // Close port if we don't detect supported firmware after 2s.
                                    if (!firmware) {
                                        errorOnNoSupportedFirmware(port.path);
                                        port.close();
                                    }
                                }, config.firmwareWaitTime * 1000);
                            }
                            //machineSend("M115\n");    // Lets check if its Marlin?

                            writeLog(chalk.yellow('INFO: ') + 'Connected to ' + port.path + ' at ' + port.settings.baudRate, 1);
                            isConnected = true;
                            connectedTo = port.path;

                            // Start interval for qCount messages to socket clients
//                        queueCounter = setInterval(function () {
//                            websocket.sockets.emit('qCount', gcodeQueue.length - queuePointer);
//                        }, 500);
                        });

                        port.on('close', function () { // open errors will be emitted as an error event
                            closeConnection();
                            writeLog(chalk.yellow('INFO: ') + chalk.blue('Port closed'), 1);
                        });

                        port.on('error', function (err) { // open errors will be emitted as an error event
                            writeLog(chalk.red('PORT ERROR: ') + chalk.blue(err.message), 1);
                            websocket.sockets.emit('error', err.message);
                            websocket.sockets.emit('connectStatus', 'closed:');
                            websocket.sockets.emit('connectStatus', 'Connect');
                        });

                        parser.on('data', function (data) {
                            dataParser(data);
                        });
                        break;

                    case 'telnet':  // Only supported by smoothieware!
                        connectedIp = data[1];
                        machineSocket = net.connect(23, connectedIp);
                        websocket.sockets.emit('connectStatus', 'opening:' + connectedIp);

                        // Telnet connection events -----------------------------------------------
                        machineSocket.on('connect', function (prompt) {
                            websocket.sockets.emit('activeIP', connectedIp);
                            websocket.sockets.emit('connectStatus', 'opened:' + connectedIp);
                            if (config.resetOnConnect == 1) {
                                machineSend(String.fromCharCode(0x18)); // ctrl-x (needed for rx/tx connection)
                                writeLog('Sent: ctrl-x', 1);
                            } else {
                                machineSend('\n'); // this causes smoothie to send the welcome string
                            }
                            setTimeout(function () { //wait for controller to be ready
                                if (!firmware) { // Grbl should be already detected
                                    machineSend('version\n'); // Check if it's Smoothieware?
                                    writeLog('Sent: version', 2);
                                    setTimeout(function () {  // Wait for Smoothie to answer
                                        if (!firmware) {     // If still not set
                                            machineSend('{fb:n}\n'); // Check if it's TinyG
                                            writeLog('Sent: {fb:n}', 2);
                                            setTimeout(function () {  // Wait for TinyG to answer
                                                if (!firmware) {     // If still not set
                                                    machineSend('M115\n'); // Check if it's RepRap
                                                    reprapBufferSize--;
                                                    writeLog('Sent: M115', 2);
                                                }
                                            }, config.tinygWaitTime * 1000);
                                        }
                                    }, config.smoothieWaitTime * 1000);
                                }
                            }, config.grblWaitTime * 1000);
                            if (config.firmwareWaitTime > 0) {
                                setTimeout(function () {
                                    // Close port if we don't detect supported firmware after 2s.
                                    if (!firmware) {
                                        errorOnNoSupportedFirmware(connectedTo);
                                        machineSocket.destroy();
                                    }
                                }, config.firmwareWaitTime * 1000);
                            }

                            writeLog(chalk.yellow('INFO: ') + chalk.blue('Telnet connected to ' + connectedIp), 1);
                            isConnected = true;
                            connectedTo = connectedIp;

                            // Start interval for qCount messages to appSocket clients
//                    queueCounter = setInterval(function () {
//                        websocket.sockets.emit('qCount', gcodeQueue.length);
//                    }, 500);
                        });

                        machineSocket.on('timeout', function () {
                            writeLog(chalk.yellow('WARN: ') + chalk.blue('Telnet timeout!'), 1);
                            machineSocket.end();
                        });

                        machineSocket.on('close', function (e) {
                            closeConnection();
                            writeLog(chalk.yellow('INFO: ') + chalk.blue('Telnet connection closed'), 1);
                        });

                        machineSocket.on('error', function (e) {
                            websocket.sockets.emit("error", e.message);
                            writeLog(chalk.red('ERROR: ') + 'Telnet error: ' + e.message, 1);
                        });

                        machineSocket.on('data', function (response) {
                            //var bytes = new Uint8Array(data);
                            for (var i = 0; i < response.length; i++) {
                                if (response[i] != 0x0d) {
                                    buffer += String.fromCharCode(response[i]);
                                }
                            }
                            var responseArray;
                            if (buffer.substr(-1) === '\n') {
                                responseArray = buffer.split('\n');
                                buffer = responseArray.pop();
                            } else {
                                responseArray = buffer.split('\n');
                                buffer = '';
                            }
                            var data = '';
                            while (responseArray.length > 0) {
                                data = responseArray.shift();
                                writeLog('Telnet: ' + data, 3);

                                dataParser(data);
                            }
                        });
                        break;

                    case 'esp8266':
                        connectedIp = data[1];
                        machineSocket = new WebSocket('ws://'+connectedIp+'/'); // connect to ESP websocket
                        websocket.sockets.emit('connectStatus', 'opening:' + connectedIp);

                        // ESP socket evnets -----------------------------------------------
                        machineSocket.on('open', function (e) {
                            websocket.sockets.emit('activeIP', connectedIp);
                            websocket.sockets.emit('connectStatus', 'opened:' + connectedIp);
                            if (config.resetOnConnect == 1) {
                                machineSend(String.fromCharCode(0x18)); // ctrl-x (reset firmware)
                                writeLog('Sent: ctrl-x', 1);
                            } else {
                                machineSend('\n'); // this causes smoothie to send the welcome string
                            }
                            setTimeout(function () { //wait for controller to be ready
                                if (!firmware) { // Grbl should be already detected
                                    machineSend('version\n'); // Check if it's Smoothieware?
                                    writeLog('Sent: version', 2);
                                    setTimeout(function () {  // Wait for Smoothie to answer
                                        if (!firmware) {     // If still not set
                                            machineSend('{fb:n}\n'); // Check if it's TinyG
                                            writeLog('Sent: {fb:n}', 2);
                                            setTimeout(function () {  // Wait for TinyG to answer
                                                if (!firmware) {     // If still not set
                                                    machineSend('M115\n'); // Check if it's RepRap Printers
                                                    reprapBufferSize--;
                                                    writeLog('Sent: M115', 2);
                                                }
                                            }, config.tinygWaitTime * 1000);
                                        }
                                    }, config.smoothieWaitTime * 1000);
                                }
                            }, config.grblWaitTime * 1000);
                            if (config.firmwareWaitTime > 0) {
                                setTimeout(function () {
                                    // Close port if we don't detect supported firmware after 2s.
                                    if (!firmware) {
                                        errorOnNoSupportedFirmware(connectedTo);
                                        machineSocket.close();
                                    }
                                }, config.firmwareWaitTime * 1000);
                            }

                            writeLog(chalk.yellow('INFO: ') + chalk.blue('ESP connected @ ' + connectedIp), 1);
                            isConnected = true;
                            connectedTo = connectedIp;
                            //machineSend(String.fromCharCode(0x18));
                        });

                        machineSocket.on('close', function (e) {
                            closeConnection();
                            writeLog(chalk.yellow('INFO: ') + chalk.blue('ESP connection closed'), 1);
                        });

                        machineSocket.on('error', function (e) {
                            websocket.sockets.emit('error', e.message);
                            websocket.sockets.emit('connectStatus', 'closed:');
                            websocket.sockets.emit('connectStatus', 'Connect');
                            writeLog(chalk.red('ESP ERROR: ') + chalk.blue(e.message), 1);
                        });

                        machineSocket.on('message', function (msg) {
                            buffer += msg;
                            var split = buffer.split(/\n/);
                            buffer = split.pop();
                            for (var i = 0; i < split.length; i++) {
                                var data = split[i];
                                if (data.length > 0) {

                                    dataParser(data);

                                    if (data.indexOf('Smoothie') >= 0) { // Check if we got smoothie welcome message
                                        firmware = 'smoothie';
                                        writeLog('Smoothieware detected, asking for version', 2);
                                    }
                                }
                            }
                        });
                        break;
                }
            } else {
                switch (connectionType) {
                    case 'usb':
                        websocket.sockets.emit("connectStatus", 'opened:' + port.path);
                        break;
                    case 'telnet':
                    case 'esp8266':
                        websocket.sockets.emit("connectStatus", 'opened:' + connectedIp);
                        break;
                }
            }
        });

        appSocket.on('runJob', function (data) {
            writeLog('Run Job (' + data.length + ')', 1);

            if (!isConnected || !data) {
                errorOnMissingConnection();

                return;
            }

            runningJob = data;
            data = data.split('\n');
            for (var i = 0; i < data.length; i++) {
                var line = data[i].split(';'); // Remove everything after ; = comment
                var tosend = line[0].trim();
                if (tosend.length > 0) {
                    if (optimizeGcode) {
                        var newMode;
                        if (tosend.indexOf('G0') === 0) {
                            tosend = tosend.replace(/\s+/g, '');
                            newMode = 'G0';
                        } else if (tosend.indexOf('G1') === 0) {
                            tosend = tosend.replace(/\s+/g, '');
                            newMode = 'G1';
                        } else if (tosend.indexOf('G2') === 0) {
                            tosend = tosend.replace(/\s+/g, '');
                            newMode = 'G2';
                        } else if (tosend.indexOf('G3') === 0) {
                            tosend = tosend.replace(/\s+/g, '');
                            newMode = 'G3';
                        } else if (tosend.indexOf('X') === 0) {
                            tosend = tosend.replace(/\s+/g, '');
                        } else if (tosend.indexOf('Y') === 0) {
                            tosend = tosend.replace(/\s+/g, '');
                        } else if (tosend.indexOf('Z') === 0) {
                            tosend = tosend.replace(/\s+/g, '');
                        } else if (tosend.indexOf('A') === 0) {
                            tosend = tosend.replace(/\s+/g, '');
                        }
                        if (newMode) {
                            if (newMode === lastMode) {
                                tosend.substr(2);
                            } else {
                                lastMode = newMode;
                            }
                        }
                    }
                    //console.log(line);
                    addQ(tosend);
                }
            }
            if (i > 0) {
                startTime = new Date(Date.now());
                // Start interval for qCount messages to socket clients
                queueCounter = setInterval(function () {
                    websocket.sockets.emit('qCount', gcodeQueue.length - queuePointer);
                }, 500);
                websocket.sockets.emit('runStatus', 'running');

                //NAB - Added to support action to run befor job starts
                doJobAction(config.jobOnStart);

                send1Q();
            }
        });

        appSocket.on('runCommand', function (data) {
            writeLog(chalk.red('Run Command (' + data.replace('\n', '|') + ')'), 1);
            if (isConnected) {
                if (data) {
                    data = data.split('\n');
                    for (var i = 0; i < data.length; i++) {
                        var line = data[i].split(';'); // Remove everything after ; = comment
                        var tosend = line[0].trim();
                        if (tosend.length > 0) {
                            addQ(tosend);
                        }
                    }
                    if (i > 0) {
                        //websocket.sockets.emit('runStatus', 'running');
                        send1Q();
                    }
                }
            } else {
                errorOnMissingConnection();
            }
        });

        appSocket.on('jog', function (data) {
            writeLog(chalk.red('Jog ' + data), 1);
            if (isConnected) {
                data = data.split(',');
                var dir = data[0];
                var dist = parseFloat(data[1]);
                var feed;
                if (data.length > 2) {
                    feed = parseInt(data[2]);
                    if (feed) {
                        feed = 'F' + feed;
                    }
                }
                if (dir && dist && feed) {
                    writeLog('Adding jog commands to queue. blocked=' + blocked + ', paused=' + paused + ', Q=' + gcodeQueue.length, 1);
                    switch (firmware) {
                        case 'grbl':
                            addQ('$J=G91' + dir + dist + feed);
                            send1Q();
                            break;
                        case 'smoothie':
                        case 'tinyg':
                        case 'repetier':
                        case 'marlinkimbra':
                            addQ('G91');
                            addQ('G0 ' + feed + dir + dist);
                            addQ('G90');
                            send1Q();
                            break;
                        case 'marlin':
                            addQ('G91');
                            addQ('G0 ' + feed +" "+ dir +" "+ dist);
                            addQ('G90');
                            send1Q();
                            break;
                        case 'reprapfirmware':
                            addQ('M120');
                            addQ('G91');
                            addQ('G1 ' + dir + dist +" "+ feed);
                            addQ('M121');
                            send1Q();
                            break;
                        default:
                            writeLog(chalk.red('ERROR: ') + chalk.blue('Unknown firmware!'), 1);
                            break;
                    }
                } else {
                    writeLog(chalk.red('ERROR: ') + chalk.blue('Invalid params!'), 1);
                }
            } else {
                errorOnMissingConnection();
            }
        });

        appSocket.on('jogTo', function (data) {     // data = {x:xVal, y:yVal, z:zVal, mode:0(absulute)|1(relative), feed:fVal}
            writeLog(chalk.red('JogTo ' + JSON.stringify(data)), 1);
            if (isConnected) {
                if (data.x !== undefined || data.y !== undefined || data.z !== undefined) {
                    var xVal = (data.x !== undefined ? 'X' + parseFloat(data.x) : '');
                    var yVal = (data.y !== undefined ? 'Y' + parseFloat(data.y) : '');
                    var zVal = (data.z !== undefined ? 'Z' + parseFloat(data.z) : '');
                    var mode = ((data.mode == 0) ? 0 : 1);
                    var feed = (data.feed !== undefined ? 'F' + parseInt(data.feed) : '');
                    writeLog('Adding jog commands to queue. blocked=' + blocked + ', paused=' + paused + ', Q=' + gcodeQueue.length);
                    switch (firmware) {
                        case 'grbl':
                            addQ('$J=G9' + mode + xVal + yVal + zVal + feed);
                            send1Q();
                            break;
                        case 'smoothie':
                        case 'tinyg':
                        case 'repetier':
                        case 'marlinkimbra':
                            addQ('G9' + mode);
                            addQ('G0' + feed + xVal + yVal + zVal);
                            addQ('G90');
                            send1Q();
                            break;
                        case 'marlin':
                            addQ('G9' + mode);
                            addQ('G0 ' + feed +" "+ xVal +" "+ yVal +" "+ zVal);
                            addQ('G90');
                            send1Q();
                            break;
                        case 'reprapfirmware':
                            addQ('M120');
                            addQ('G9' + mode);
                            addQ('G1 ' + feed +" "+ xVal +" "+ yVal +" "+ zVal);
                            addQ('G90');
                            addQ('M121');
                            send1Q();
                            break;
                        default:
                            writeLog(chalk.red('ERROR: ') + chalk.blue('Unknown firmware!'), 1);
                            break;
                    }
                } else {
                    writeLog(chalk.red('error') + chalk.blue('Invalid params!'), 1);
                    websocket.sockets.emit('data', 'Invalid jogTo() params!');
                }
            } else {
                errorOnMissingConnection();
            }
        });

        appSocket.on('setZero', function (data) {
            writeLog(chalk.red('setZero(' + data + ')'), 1);
            if (isConnected) {
                switch (data) {
                    case 'x':
                        if (firmware == "marlin" || firmware == "reprapfirmware")
                            addQ('G92 X0');
                        else
                            addQ('G10 L20 P0 X0');
                        break;
                    case 'y':
                        if (firmware == "marlin" || firmware == "reprapfirmware")
                            addQ('G92 Y0');
                        else
                            addQ('G10 L20 P0 Y0');
                        break;
                    case 'z':
                        if (firmware == "marlin" || firmware == "reprapfirmware")
                            addQ('G92 Z0');
                        else
                            addQ('G10 L20 P0 Z0');
                        break;
                    case 'a':
                        if (firmware == "marlin" || firmware == "reprapfirmware")
                            addQ('G92 E0');
                        else
                            addQ('G10 L20 P0 A0');
                        break;
                    case 'all':
                        switch (firmware) {
                            case 'repetier':
                                addQ('G92');
                                break;
                            case 'marlinkimbra':
                            case 'marlin':
                            case 'reprapfirmware':
                                addQ('G92 X0 Y0 Z0');
                                break;
                            default:
                                addQ('G10 L20 P0 X0 Y0 Z0');
                                break;
                        }
                        break;
                    case 'xyza':
                        if (firmware == "marlin" || firmware == "reprapfirmware")
                            addQ('G92 X0 Y0 Z0 E0');
                        else
                            addQ('G10 L20 P0 X0 Y0 Z0 A0');
                        break;
                }
                send1Q();
            } else {
                errorOnMissingConnection();
            }
        });

        appSocket.on('gotoZero', function (data) {
            writeLog(chalk.red('gotoZero(' + data + ')'), 1);
            if (isConnected) {
                switch (data) {
                    case 'x':
                        addQ('G0 X0');
                        break;
                    case 'y':
                        addQ('G0 Y0');
                        break;
                    case 'z':
                        addQ('G0 Z0');
                        break;
                    case 'a':
                        addQ('G0 A0');
                        break;
                    case 'all':
                        addQ('G0 X0 Y0 Z0');
                        break;
                    case 'xyza':
                        addQ('G0 X0 Y0 Z0 A0');
                        break;
                }
                send1Q();
            } else {
                errorOnMissingConnection();
            }
        });

        appSocket.on('setPosition', function (data) {
            writeLog(chalk.red('setPosition(' + JSON.stringify(data) + ')'), 1);
            if (isConnected) {
                if (data.x !== undefined || data.y !== undefined || data.z !== undefined) {
                    var xVal = (data.x !== undefined ? 'X' + parseFloat(data.x) + ' ' : '');
                    var yVal = (data.y !== undefined ? 'Y' + parseFloat(data.y) + ' ' : '');
                    var zVal = (data.z !== undefined ? 'Z' + parseFloat(data.z) + ' ' : '');
                    var aVal = (data.a !== undefined ? 'A' + parseFloat(data.a) + ' ' : '');
                    addQ('G10 L20 P0 ' + xVal + yVal + zVal + aVal);
                    send1Q();
                }
            } else {
                errorOnMissingConnection();
            }
        });

        appSocket.on('home', function (data) {
            writeLog(chalk.red('home(' + data + ')'), 1);
            if (!isConnected) {
                errorOnMissingConnection();
                return;
            }

            switch (data) {
                case 'x':
                    homeAxis('X');
                    break;
                case 'y':
                    homeAxis('Y');
                    break;
                case 'z':
                    homeAxis('Z');
                    break;
                case 'a':
                    switch (firmware) {
                        case 'smoothie':
                        case 'repetier':
                        case 'marlinkimbra':
                            addQ('G28.2 E1');
                        break;
                        case 'marlin':
                            addQ('G28 E1'); // ????
                            break;
                        case 'tinyg':
                            addQ('G28.2 A0');
                            break;
                        default:
                            //not supported
                            appSocket.emit('error', 'Command not supported by firmware!');
                            break;
                    }
                    break;
                case 'all': // XYZ only!!
                    switch (firmware) {
                        case 'grbl':
                            addQ('$H');
                            break;
                        case 'smoothie':
                        case 'repetier':
                        case 'marlinkimbra':
                            addQ('G28.2 X Y Z');
                            break;
                        case 'marlin':
                        case 'reprapfirmware':
                            addQ('G28 X Y Z');
                            break;
                        case 'tinyg':
                            addQ('G28.2 X0 Y0 Z0');
                            break;
                        default:
                            //not supported
                            appSocket.emit('error', 'Command not supported by firmware!');
                            break;
                    }
                    break;
                case 'xyza':
                    switch (firmware) {
                        case 'grbl':
                            addQ('$H');
                            break;
                        case 'smoothie':
                        case 'repetier':
                        case 'marlinkimbra':
                            addQ('G28.2 X Y Z E');
                            break;
                        case 'marlin':
                        case 'reprapfirmware':
                            addQ('G28 X Y Z E');
                            break;
                        case 'tinyg':
                            addQ('G28.2 X0 Y0 Z0 A0');
                            break;
                        default:
                            //not supported
                            appSocket.emit('error', 'Command not supported by firmware!');
                            break;
                    }
                    break;
            }
            send1Q();
        });

        appSocket.on('probe', function (data) {
            writeLog(chalk.red('probe(' + JSON.stringify(data) + ')'), 1);
            if (isConnected) {
                switch (firmware) {
                    case 'smoothie':
                        switch (data.direction) {
                            case 'z':
                                addQ('G30 Z' + data.probeOffset);
                                break;
                            default:
                                addQ('G38.2 ' + data.direction);
                                break;
                        }
                        break;
                    case 'grbl':
                        addQ('G38.2 ' + data.direction + '-5 F1');
                        addQ('G92 ' + data.direction + ' ' + data.probeOffset);
                        break;
                    case 'repetier':
                    case 'marlinkimbra':
                        addQ('G38.2 ' + data.direction + '-5 F1');
                        break;
                    case 'reprapfirmware':
                        switch (data.direction) {
                            case 'z':
                                addQ('G30');
                                break;
                        }
                        break;
                    default:
                        //not supported
                        appSocket.emit('error', 'Command not supported by firmware!');
                        break;
                }
                send1Q();
            } else {
                errorOnMissingConnection();
            }
        });

        appSocket.on('feedOverride', function (data) {
            if (!isConnected) {
                errorOnMissingConnection();
                return;
            }

            switch (firmware) {
                case 'grbl':
                    var code;
                    switch (data) {
                        case 0:
                            code = 144; // set to 100%
                            data = '100';
                            break;
                        case 10:
                            code = 145; // +10%
                            data = '+' + data;
                            break;
                        case -10:
                            code = 146; // -10%
                            break;
                        case 1:
                            code = 147; // +1%
                            data = '+' + data;
                            break;
                        case -1:
                            code = 148; // -1%
                            break;
                    }
                    if (code) {
                        //jumpQ(String.fromCharCode(parseInt(code)));
                        machineSend(String.fromCharCode(parseInt(code)));
                        writeLog('Sent: Code(' + code + ')', 2);
                        writeLog(chalk.red('Feed Override ' + data + '%'), 1);
                    }
                    break;
                case 'smoothie':
                    if (data === 0) {
                        feedOverride = 100;
                    } else {
                        if ((feedOverride + data <= 200) && (feedOverride + data >= 10)) {
                            // valid range is 10..200, else ignore!
                            feedOverride += data;
                        }
                    }
                    //jumpQ('M220S' + feedOverride);
                    machineSend('M220S' + feedOverride + '\n');
                    writeLog('Sent: M220S' + feedOverride, 2);
                    websocket.sockets.emit('feedOverride', feedOverride);
                    writeLog(chalk.red('Feed Override ' + feedOverride.toString() + '%'), 1);
                    //send1Q();
                    break;
                case 'tinyg':
                    break;
                case 'repetier':
                case 'marlinkimbra':
                case 'reprapfirmware':
                    if (data === 0) {
                        feedOverride = 100;
                    } else {
                        if ((feedOverride + data <= 200) && (feedOverride + data >= 10)) {
                            // valid range is 10..200, else ignore!
                            feedOverride += data;
                        }
                    }
                    machineSend('M220 S' + feedOverride + '\n');
                    reprapBufferSize--;
                    writeLog('Sent: M220 S' + feedOverride, 2);
                    websocket.sockets.emit('feedOverride', feedOverride);
                    writeLog(chalk.red('Feed Override ' + feedOverride.toString() + '%'), 1);
                    break;
            }
        });

        appSocket.on('spindleOverride', function (data) {
            if (isConnected) {
                switch (firmware) {
                    case 'grbl':
                        var code;
                        switch (data) {
                            case 0:
                                code = 153; // set to 100%
                                data = '100';
                                break;
                            case 10:
                                code = 154; // +10%
                                data = '+' + data;
                                break;
                            case -10:
                                code = 155; // -10%
                                break;
                            case 1:
                                code = 156; // +1%
                                data = '+' + data;
                                break;
                            case -1:
                                code = 157; // -1%
                                break;
                        }
                        if (code) {
                            //jumpQ(String.fromCharCode(parseInt(code)));
                            machineSend(String.fromCharCode(parseInt(code)));
                            writeLog('Sent: Code(' + code + ')', 2);
                            writeLog(chalk.red('Spindle (Laser) Override ' + data + '%'), 1);
                        }
                        break;
                    case 'smoothie':
                        if (data === 0) {
                            spindleOverride = 100;
                        } else {
                            if ((spindleOverride + data <= 200) && (spindleOverride + data >= 0)) {
                                // valid range is 0..200, else ignore!
                                spindleOverride += data;
                            }
                        }
                        //jumpQ('M221S' + spindleOverride);
                        machineSend('M221S' + spindleOverride + '\n');
                        writeLog('Sent: M221S' + spindleOverride, 2);
                        websocket.sockets.emit('spindleOverride', spindleOverride);
                        writeLog(chalk.red('Spindle (Laser) Override ' + spindleOverride.toString() + '%'), 1);
                        //send1Q();
                        break;
                    case 'tinyg':
                        break;
                    case 'repetier':
                    case 'marlinkimbra':
                    case 'reprapfirmware':
                        if (data === 0) {
                            spindleOverride = 100;
                        } else {
                            if ((spindleOverride + data <= 200) && (spindleOverride + data >= 0)) {
                                // valid range is 0..200, else ignore!
                                spindleOverride += data;
                            }
                        }
                        machineSend('M221 S' + spindleOverride + '\n');
                        reprapBufferSize--;
                        writeLog('Sent: M221 S' + spindleOverride, 2);
                        websocket.sockets.emit('spindleOverride', spindleOverride);
                        writeLog(chalk.red('Spindle (Laser) Override ' + spindleOverride.toString() + '%'), 1);
                        break;
                }
            } else {
                errorOnMissingConnection();
            }
        });

        appSocket.on('laserTest', function (data) { // Laser Test Fire
            if (!isConnected) {
                errorOnMissingConnection();
                return;
            }

            data = data.split(',');
            var power = parseFloat(data[0]);
            var duration = parseInt(data[1]);
            var maxS = parseFloat(data[2]);

            if (power == 0) {
                return
            }

            if (laserTestOn) {
                writeLog('laserTest: ' + 'Power off', 1);
                switch (firmware) {
                    case 'grbl':
                        addQ('M5S0');
                        break;
                    case 'smoothie':
                        addQ('fire off\n');
                        addQ('M5\n');
                        break;
                    case 'tinyg':
                        addQ('M5S0');
                        break;
                    case 'repetier':
                    case 'marlinkimbra':
                        addQ('M5');
                        break;
                    case 'marlin':
                        addQ('M107');
                        break;
                    case 'reprapfirmware':
                        addQ('M106 S0');
                        break;
                }
                send1Q();
                laserTestOn = false;
                appSocket.emit('laserTest', 0);
                return;
            }

            // laserTest is off
            writeLog('laserTest: ' + 'Power ' + power + ', Duration ' + duration + ', maxS ' + maxS, 1);
            if (duration >= 0) {
                switch (firmware) {
                    case 'grbl':
                        addQ('G1F1');
                        addQ('M3S' + parseInt(power * maxS / 100));
                        laserTestOn = true;
                        appSocket.emit('laserTest', power);
                        if (duration > 0) {
                            addQ('G4 P' + duration / 1000);
                            addQ('M5S0');
                            laserTestOn = false;
                            //appSocket.emit('laserTest', 0); //-> Grbl get the real state with status report
                        }
                        break;
                    case 'smoothie':
                        var divider = (fDate >= new Date('2017-01-02')) ? 1000 : 1;

                        laserTest(power, ['M3\n', 'fire ' + power + '\n'], ['G4P' + duration / divider + '\n', 'fire off\n', 'M5']);
                        break;
                    case 'tinyg':
                        laserTest(power,['G1F1', 'M3S' + parseInt(power * maxS / 100)], ['G4 P' + duration / 1000, 'M5S0']);
                        break;
                    case 'repetier':
                    case 'marlinkimbra':
                        laserTest(power,['G1F1', 'M3 S' + parseInt(power * maxS / 100), 'M4'], ['G4 P' + duration, 'M5']);
                        break;
                    case 'marlin':
                        laserTest(power,['G1 F1', 'M106 S' + parseInt(power * maxS / 100)], ['G4 P' + duration, 'M107']);
                        break;
                    case 'reprapfirmware':
                        laserTest(power,['G1 F1', 'M106 S' + parseInt(power * maxS / 100)], ['G4 P' + duration, 'M106 S0']);
                        break;
                }

                send1Q();
            }
        });

        appSocket.on('pause', function () {
            if (isConnected) {
                paused = true;
                writeLog(chalk.red('PAUSE'), 1);
                switch (firmware) {
                    case 'grbl':
                        machineSend('!'); // Send hold command
                        writeLog('Sent: !', 2);
                        if (fVersion === '1.1d') {
                            machineSend(String.fromCharCode(0x9E)); // Stop Spindle/Laser
                            writeLog('Sent: Code(0x9E)', 2);
                        }
                        break;
                    case 'smoothie':
                        machineSend('!'); // Laser will be turned off by smoothie (in default config!)
                        //machineSend('M600\n'); // Laser will be turned off by smoothie (in default config!)
                        writeLog('Sent: !', 2);
                        break;
                    case 'tinyg':
                        machineSend('!'); // Send hold command
                        writeLog('Sent: !', 2);
                        break;
                    case 'repetier':
                    case 'marlinkimbra':
                    case 'marlin':
                        // just stop sending gcodes
                        break;
                    case 'reprapfirmware':
                        // pause SD print and stop sending gcodes
                        machineSend('M25'); // Send hold command
                        writeLog('Sent: M25', 2);
                        break;
                }
                websocket.sockets.emit('runStatus', 'paused');
            } else {
                errorOnMissingConnection();
            }
        });

        appSocket.on('resume', function () {
            if (!isConnected) {
                errorOnMissingConnection();
                return;
            }

            writeLog(chalk.red('UNPAUSE'), 1);
            //websocket.sockets.emit('connectStatus', 'unpaused:' + port.path);
            switch (firmware) {
                case 'grbl':
                case 'smoothie':
                case 'tinyg':
                    machineSend('~'); // Send resume command
                    writeLog('Sent: ~', 2);
                    break;
                case 'repetier':
                case 'marlinkimbra':
                case 'marlin':
                    break;
                case 'reprapfirmware':
                    // resume SD print (if used)
                    machineSend('M24'); // Send resume command
                    writeLog('Sent: M24', 2);
                    break;
            }
            paused = false;
            send1Q(); // restart queue
            websocket.sockets.emit('runStatus', 'resumed');
        });

        appSocket.on('stop', function () {
            if (isConnected) {
                paused = true;
                writeLog(chalk.red('STOP'), 1);
                switch (firmware) {
                    case 'grbl':
                        machineSend('!'); // hold
                        writeLog('Sent: !', 2);
                        if (fVersion === '1.1d') {
                            machineSend(String.fromCharCode(0x9E)); // Stop Spindle/Laser
                            writeLog('Sent: Code(0x9E)', 2);
                        }
                        writeLog('Cleaning Queue', 1);
                        gcodeQueue.length = 0; // Dump the Queye
                        grblBufferSize.length = 0; // Dump bufferSizes
                        queuePointer = 0;
                        startTime = null;
                        machineSend(String.fromCharCode(0x18)); // ctrl-x
                        writeLog('Sent: Code(0x18)', 2);
                        blocked = false;
                        paused = false;
                        break;
                    case 'smoothie':
                        paused = true;
                        machineSend(String.fromCharCode(0x18)); // ctrl-x
                        writeLog('Sent: Code(0x18)', 2);
                        break;
                    case 'tinyg':
                        paused = true;
                        machineSend('!'); // hold
                        writeLog('Sent: !', 2);
                        machineSend('%'); // dump TinyG queue
                        writeLog('Sent: %', 2);
                        break;
                    case 'repetier':
                    case 'marlinkimbra':
                    case 'marlin':
                    case 'reprapfirmware':
                        paused = true;
                        machineSend('M112/n'); // abort
                        writeLog('Sent: M112', 2);
                        break;
                }
                clearInterval(queueCounter);
                websocket.sockets.emit('qCount', 0);
                gcodeQueue.length = 0; // Dump the Queye
                grblBufferSize.length = 0; // Dump bufferSizes
                tinygBufferSize = TINYG_RX_BUFFER_SIZE;  // reset tinygBufferSize
                reprapBufferSize = REPRAP_RX_BUFFER_SIZE; // reset reprapBufferSize
                reprapWaitForPos = false;
                queuePointer = 0;
                laserTestOn = false;
                startTime = null;
                runningJob = null;
                blocked = false;
                paused = false;
                websocket.sockets.emit('runStatus', 'stopped');

                //NAB - Added to support action to run after job aborts
                doJobAction(config.jobOnAbort);

            } else {
                errorOnMissingConnection();
            }
        });

        appSocket.on('sd.list', function () {  // List SD content
            if (isConnected) {
                writeLog(chalk.red('sd.list'), 1);
                switch (firmware) {
                    case 'smoothie':
                        machineSend('ls/n');
                        writeLog('Sent: ls', 2);
                        break;
                    case 'repetier':
                        break;
                    case 'marlin':
                    case 'marlinkimbra':
                        machineSend('M20/n');
                        writeLog('Sent: M20', 2);
                        break;
                    case 'reprapfirmware':
                        machineSend('M20 S2/n');
                        writeLog('Sent: M20 S2', 2);
                        break;
                }
            }
        });

        appSocket.on('sd.cd', function (data) {  // Change directory
            if (isConnected) {
                writeLog(chalk.red('sd.cd'), 1);
                switch (firmware) {
                    case 'smoothie':
                        machineSend('cd ' + data + '/n');
                        writeLog('Sent: cd', 2);
                        break;
                    case 'repetier':
                        break;
                    case 'marlin':
                    case 'marlinkimbra':
                    case 'reprapfirmware':
                        //sdFolder = data;    // not finished!
                        break;
                }
            }
        });

        appSocket.on('sd.rm', function (data) {  // Delete file
            if (isConnected) {
                writeLog(chalk.red('sd.rm'), 1);
                switch (firmware) {
                    case 'smoothie':
                        machineSend('rm ' + data + '/n');
                        writeLog('Sent: rm', 2);
                        break;
                    case 'repetier':
                    case 'marlin':
                    case 'marlinkimbra':
                    case 'reprapfirmware':
                        machineSend('M30 ' + data + '/n');
                        writeLog('Sent: rm', 2);
                        break;
                }
            }
        });

        appSocket.on('sd.mv', function (data) {  // Rename/move file
            if (isConnected) {
                writeLog(chalk.red('sd.mv'), 1);
                switch (firmware) {
                    case 'smoothie':
                        machineSend('mv ' + data.file + ' ' + data.newfile + '/n');
                        writeLog('Sent: mv', 2);
                        break;
                    case 'repetier':
                    case 'marlin':
                    case 'marlinkimbra':
                    case 'reprapfirmware':
                        break;
                }
            }
        });

        appSocket.on('sd.play', function (data) {  // Play file
            if (isConnected) {
                writeLog(chalk.red('sd.play'), 1);
                switch (firmware) {
                    case 'smoothie':
                        machineSend('play ' + data + '/n');
                        writeLog('Sent: play', 2);
                        break;
                    case 'repetier':
                        break;
                    case 'marlin':
                    case 'marlinkimbra':
                    case 'reprapfirmware':
                        machineSend('M23 ' + data + '/n');
                        writeLog('Sent: M23', 2);
                        machineSend('M24/n');
                        writeLog('Sent: M24', 2);
                        break;
                }
            }
        });

        appSocket.on('sd.pause', function () {  // Abort SD print
            if (isConnected) {
                writeLog(chalk.red('sd.abort'), 1);
                switch (firmware) {
                    case 'smoothie':
                        machineSend('suspend/n');
                        writeLog('Sent: suspend', 2);
                        break;
                    case 'repetier':
                        break;
                    case 'marlin':
                    case 'marlinkimbra':
                    case 'reprapfirmware':
                        machineSend('M25/n');
                        writeLog('Sent: M25', 2);
                        break;
                }
            }
        });

        appSocket.on('sd.resume', function () {  // Resume SD print
            if (isConnected) {
                writeLog(chalk.red('sd.resume'), 1);
                switch (firmware) {
                    case 'smoothie':
                        machineSend('resume/n');
                        writeLog('Sent: resume', 2);
                        break;
                    case 'repetier':
                        break;
                    case 'marlin':
                    case 'marlinkimbra':
                    case 'reprapfirmware':
                        machineSend('M24/n');
                        writeLog('Sent: M24', 2);
                        break;
                }
            }
        });

        appSocket.on('sd.abort', function () {  // Abort SD print
            if (isConnected) {
                writeLog(chalk.red('sd.abort'), 1);
                switch (firmware) {
                    case 'smoothie':
                        machineSend('abort/n');
                        writeLog('Sent: abort', 2);
                        break;
                    case 'marlin':
                    case 'marlinkimbra':
                    case 'reprapfirmware':
                        machineSend('M112/n');
                        writeLog('Sent: M112', 2);
                        break;
                    case 'repetier':
                        break;
                }
            }
        });

        appSocket.on('sd.upload', function (data) {  // Upload file to SD
            if (isConnected) {
                writeLog(chalk.red('sd.upload'), 1);
                switch (firmware) {
                    case 'smoothie':
                        machineSend('upload ' + data.filename + '' + data.gcode + '/n');
                        writeLog('Sent: upload', 2);
                        break;
                    case 'marlin':
                    case 'marlinkimbra':
                    case 'reprapfirmware':
                        machineSend('M28 ' + data.filename + '/n');
                        writeLog('Sent: M28 ' + data.filename, 2);
                        machineSend(data.gcode + '/n');
                        machineSend('M29 ' + data.filename + '/n');
                        writeLog('Sent: M29 ' + data.filename, 2);
                        break;
                    case 'repetier':
                        break;
                }
            }
        });

        appSocket.on('sd.progress', function (data) {  // Get SD print progress
            if (isConnected) {
                writeLog(chalk.red('sd.progtress'), 1);
                switch (firmware) {
                    case 'smoothie':
                        machineSend('progress/n');
                        writeLog('Sent: progress', 2);
                        break;
                    case 'marlin':
                    case 'marlinkimbra':
                    case 'reprapfirmware':
                        machineSend('M27/n');
                        writeLog('Sent: M27', 2);
                        break;
                    case 'repetier':
                        break;
                }
            }
        });

        appSocket.on('clearAlarm', function (data) { // Clear Alarm
            if (isConnected) {
                data = parseInt(data);
                writeLog('Clearing Queue: Method ' + data, 1);
                switch (data) {
                    case 1:
                        writeLog('Clearing Lockout');
                        switch (firmware) {
                            case 'grbl':
                            case 'tinyg':
                                machineSend('$X\n');
                                writeLog('Sent: $X', 2);
                                break;
                            case 'smoothie':
                                machineSend('$X\n');
                                writeLog('Sent: $X', 2);
                                machineSend('~\n');
                                writeLog('Sent: ~', 2);
                                break;
                            case 'repetier':
                            case 'marlinkimbra':
                            case 'marlin':
                            case 'reprapfirmware':
                                machineSend('M112\n');
                                writeLog('Sent: M112', 2);
                                break;
                        }
                        writeLog('Resuming Queue Lockout', 1);
                        break;
                    case 2:
                        writeLog('Emptying Queue', 1);
                        gcodeQueue.length = 0; // Dump the Queye
                        grblBufferSize.length = 0; // Dump bufferSizes
                        tinygBufferSize = TINYG_RX_BUFFER_SIZE;  // reset tinygBufferSize
                        reprapBufferSize = REPRAP_RX_BUFFER_SIZE; // reset reprapBufferSize
                        reprapWaitForPos = false;
                        queuePointer = 0;
                        startTime = null;
                        writeLog('Clearing Lockout', 1);
                        switch (firmware) {
                            case 'grbl':
                                machineSend('$X\n');
                                writeLog('Sent: $X', 2);
                                blocked = false;
                                paused = false;
                                break;
                            case 'smoothie':
                                machineSend('$X\n'); //M999
                                writeLog('Sent: $X', 2);
                                machineSend('~\n');
                                writeLog('Sent: ~', 2);
                                blocked = false;
                                paused = false;
                                break;
                            case 'tinyg':
                                machineSend('%'); // flush tinyg quere
                                writeLog('Sent: %', 2);
                                //machineSend('~'); // resume
                                //writeLog('Sent: ~', 2);
                                blocked = false;
                                paused = false;
                                break;
                            case 'repetier':
                            case 'marlinkimbra':
                            case 'marlin':
                            case 'reprapfirmware':
                                machineSend('M112/n');
                                writeLog('Sent: M112', 2);
                                blocked = false;
                                paused = false;
                                break;
                        }
                        break;
                }
                websocket.sockets.emit('runStatus', 'stopped');
            } else {
                errorOnMissingConnection();
            }
        });

        appSocket.on('resetMachine', function () {
            if (!isConnected) {
                errorOnMissingConnection();
                return;
            }

            writeLog(chalk.red('Reset Machine'), 1);
            switch (firmware) {
                case 'grbl':
                case 'smoothie':
                case 'tinyg':
                    machineSend(String.fromCharCode(0x18)); // ctrl-x
                    writeLog('Sent: Code(0x18)', 2);
                    break;
                case 'repetier':
                case 'marlinkimbra':
                case 'marlin':
                case 'reprapfirmware':
                    machineSend('M112/n');
                    writeLog('Sent: M112', 2);
                    break;
            }
        });

        appSocket.on('closePort', function (data) { // Close machine port and dump queue
            if (!isConnected) {
                errorOnMissingConnection();
                return;
            }

            if (connectionType == 'usb') {
                writeLog(chalk.yellow('WARN: ') + chalk.blue('Closing Port ' + port.path), 1);
                websocket.sockets.emit("connectStatus", 'closing:' + port.path);
            } else {
                writeLog(chalk.yellow('WARN: ') + chalk.blue('Closing ' + connectionType + ' @ ' + connectedIp), 1);
                websocket.sockets.emit("connectStatus", 'closing:' + connectedIp);
            }

            closeConnection();

            if (connectionType == 'usb') {
                port.close();
            } else {
                machineSocket.close();
            }
        });

        appSocket.on('disconnect', function () { // App disconnected
            let id = connections.indexOf(appSocket);
            writeLog(chalk.yellow('App disconnected! (id=' + id + ')'), 1);
            connections.splice(id, 1);
        });

    }); // End appSocket


// Queue
    function addQ(gcode) {
        gcodeQueue.push(gcode);
    }

    function grblBufferSpace() {
        var total = 0;
        var len = grblBufferSize.length;
        for (var i = 0; i < len; i++) {
            total += grblBufferSize[i];
        }
        return GRBL_RX_BUFFER_SIZE - total;
    }

    function machineSend(gcode) {
        switch (connectionType) {
            case 'usb':
                port.write(gcode);
                break;
            case 'telnet':
                machineSocket.write(gcode);
                break;
            case 'esp8266':
                machineSocket.send(gcode);
                break;
        }
    }

    function send1Q() {
        var gcode;
        var gcodeLen = 0;
        var gcodeLine = '';
        var spaceLeft = 0;

        if (!isConnected) {
            errorOnMissingConnection();
            return;
        }

        switch (firmware) {
            case 'grbl':
                if (new_grbl_buffer) {
                    if (grblBufferSize.length === 0){
                        spaceLeft = GRBL_RX_BUFFER_SIZE;
                        while ((gcodeQueue.length - queuePointer) > 0 && spaceLeft > 0 && !blocked && !paused) {
                            gcodeLen = gcodeQueue[queuePointer].length;
                            if (gcodeLen < spaceLeft) {
                                // Add gcode to send buffer
                                gcode = gcodeQueue[queuePointer];
                                queuePointer++;
                                grblBufferSize.push(gcodeLen + 1);
                                gcodeLine += gcode + '\n';
                                spaceLeft = GRBL_RX_BUFFER_SIZE - gcodeLine.length;
                            } else {
                                // Not enough space left in send buffer
                                blocked = true;
                            }
                        }
                        if (gcodeLine.length > 0) {
                            // Send the buffer
                            blocked = true;
                            machineSend(gcodeLine);
                            writeLog('Sent: ' + gcodeLine + ' Q: ' + (gcodeQueue.length - queuePointer), 2);
                        }
                    }
                } else {
                    while ((gcodeQueue.length - queuePointer) > 0 && !blocked && !paused) {
                        spaceLeft = grblBufferSpace();
                        gcodeLen = gcodeQueue[queuePointer].length;
                        if (gcodeLen < spaceLeft) {
                            gcode = gcodeQueue[queuePointer];
                            queuePointer++;
                            grblBufferSize.push(gcodeLen + 1);
                            machineSend(gcode + '\n');
                            writeLog('Sent: ' + gcode + ' Q: ' + (gcodeQueue.length - queuePointer) + ' Bspace: ' + (spaceLeft - gcodeLen - 1), 2);
                        } else {
                            blocked = true;
                        }
                    }
                }
                break;
            case 'smoothie':
                if (smoothie_buffer) {
                    spaceLeft = SMOOTHIE_RX_BUFFER_SIZE;
                    while ((gcodeQueue.length - queuePointer) > 0 && spaceLeft > 5 && !blocked && !paused) {
                        gcodeLen = gcodeQueue[queuePointer].length;
                        if (gcodeLen < spaceLeft) {
                            // Add gcode to send buffer
                            gcodeLine += gcodeQueue[queuePointer];
                            queuePointer++;
                            spaceLeft -= gcodeLen;
                        } else {
                            // Not enough space left in send buffer
                            blocked = true;
                        }
                    }
                    if (gcodeLine.length > 0) {
                        // Send the buffer
                        blocked = true;
                        machineSend(gcodeLine + '\n');
                        writeLog('Sent: ' + gcodeLine + ' Q: ' + (gcodeQueue.length - queuePointer), 2);
                    }
                } else {
                    if ((gcodeQueue.length  - queuePointer) > 0 && !blocked && !paused) {
                        gcode = gcodeQueue[queuePointer];
                        queuePointer++;
                        blocked = true;
                        machineSend(gcode + '\n');
                        writeLog('Sent: ' + gcode + ' Q: ' + gcodeQueue.length, 2);
                    }
                }
                break;
            case 'tinyg':
            case 'repetier':
            case 'marlinkimbra':
            case 'marlin':
            case 'reprapfirmware':
                while (reprapBufferSize > 0 && gcodeQueue.length > 0 && !blocked && !paused) {
                    gcode = gcodeQueue.shift();
                    machineSend(gcode + '\n');
                    reprapBufferSize--;
                    writeLog('Sent: ' + gcode + ' Q: ' + gcodeQueue.length, 2);
                }
                break;
        }
        var finishTime, elapsedTimeMS, elapsedTime, speed;
        if (startTime && (queuePointer >= 500)) {
            finishTime = new Date(Date.now());
            elapsedTimeMS = finishTime.getTime() - startTime.getTime();
            elapsedTime = Math.round(elapsedTimeMS / 1000);
            speed = (queuePointer / elapsedTime).toFixed(0);
            writeLog('Done: ' + queuePointer + ' of ' + gcodeQueue.length + ' (ave. ' + speed + ' lines/s)', 1);
        }
        if (queuePointer >= gcodeQueue.length) {
            clearInterval(queueCounter);
            websocket.sockets.emit('qCount', 0);
            if (startTime) {
                finishTime = new Date(Date.now());
                elapsedTimeMS = finishTime.getTime() - startTime.getTime();
                elapsedTime = Math.round(elapsedTimeMS / 1000);
                speed = (queuePointer / elapsedTime).toFixed(0);
                writeLog("Job started at " + startTime.toString(), 1);
                writeLog("Job finished at " + finishTime.toString(), 1);
                writeLog("Elapsed time: " + elapsedTime + " seconds.", 1);
                writeLog('Ave. Speed: ' + speed + ' lines/s', 1);
            }
            gcodeQueue.length = 0; // Dump the Queye
            grblBufferSize.length = 0; // Dump bufferSizes
            tinygBufferSize = TINYG_RX_BUFFER_SIZE;  // reset tinygBufferSize
            reprapBufferSize = REPRAP_RX_BUFFER_SIZE;  // reset tinygBufferSize
            queuePointer = 0;
            startTime = null;
            runningJob = null;
            websocket.sockets.emit('runStatus', 'finished');

            //NAB - Added to support action to run after job completes
            doJobAction(config.jobOnFinish);
        }
    }

    function isElectron() {
        if (typeof window !== 'undefined' && window.process && window.process.type === 'renderer') {
            return true;
        }
        if (typeof process !== 'undefined' && process.versions && !!process.versions.electron) {
            return true;
        }
        return false;
    }

    function writeLog(line, verb) {
        if (verb<=config.verboseLevel) {
            console.log(line);
        }
        if (config.logLevel>0 && verb<=config.logLevel) {
            if (!logFile) {
                if (isElectron() && os.platform == 'darwin') {
                    //websocket.sockets.emit('data', 'Running on Darwin (macOS)');
                    logFile = fs.createWriteStream(path.join(electronApp.getPath('userData'),'logfile.txt'));
                } else {
                    logFile = fs.createWriteStream('./logfile.txt');
                }
                logFile.on('error', function(e) { console.error(e); });
            }
            var time = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
            line = line.split(String.fromCharCode(0x1B) + '[31m').join('');
            line = line.split(String.fromCharCode(0x1B) + '[32m').join('');
            line = line.split(String.fromCharCode(0x1B) + '[33m').join('');
            line = line.split(String.fromCharCode(0x1B) + '[34m').join('');
            line = line.split(String.fromCharCode(0x1B) + '[35m').join('');
            line = line.split(String.fromCharCode(0x1B) + '[36m').join('');
            line = line.split(String.fromCharCode(0x1B) + '[37m').join('');
            line = line.split(String.fromCharCode(0x1B) + '[38m').join('');
            line = line.split(String.fromCharCode(0x1B) + '[39m').join('');
            line = line.split(String.fromCharCode(0x1B) + '[94m').join('');
            logFile.write(time + ' ' + line + '\r\n');
        }
    }

    //Handles performing any pre/post/abort actions
    //Action = command line specific for OS
    function doJobAction(action) {
        //NAB - Added to support action to run after job completes
        if (typeof action === 'string' && action.length > 0) {
            try {
                exec(action);
            } catch (e) {
                //Unable to start jobAfter command
                writeLog(chalk.red('ERROR: ') + chalk.blue('Error on job command: ' + e.message + ' for action: ' + action), 2);
            }
        }
    }
}

if (require.main === module) {
    exports.LWCommServer(config);
}