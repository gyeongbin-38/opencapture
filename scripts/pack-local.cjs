const {build}=require('electron-builder');
const config=require('../electron-builder.config.js');
config.electronDist='node_modules/electron/dist';
config.directories.output='release';
config.win.signAndEditExecutable=false;
build({config,dir:true}).catch(e=>{console.error(e);process.exitCode=1});
