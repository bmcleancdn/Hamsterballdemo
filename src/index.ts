/* CSCI 4262 Project
 * Authors: Alastair St. Clair, Benjamin McLean
 */

// STARTING CODE ADAPTED FROM:
/* CSCI 4262 Assignment 3,
 * Author: Evan Suma Rosenberg
 * License: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 */ 

import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Color3, Vector3 } from "@babylonjs/core/Maths/math";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { PointerEventTypes, PointerInfo } from "@babylonjs/core/Events/pointerEvents";
import { WebXRCamera, WebXRControllerComponent, WebXRControllerPhysics, WebXRManagedOutputCanvasOptions } from "@babylonjs/core/XR";
import { WebXRInputSource } from "@babylonjs/core/XR/webXRInputSource";

// Side effects
import "@babylonjs/loaders/glTF/2.0/glTFLoader"
import "@babylonjs/core/Helpers/sceneHelpers";
import "@babylonjs/inspector";
import { AbstractMesh, AmmoJSPlugin, AssetsManager, CubeTexture, HemisphericLight, HighlightLayer, Mesh, MeshAssetTask, MeshBuilder, PhysicsImpostor, SceneLoader, Sound, StandardMaterial, Texture, TransformNode } from "@babylonjs/core";
import "@babylonjs/core/Physics/physicsEngineComponent";
import ammo from "ammojs-typed";

const DRAG_SENSITIVITY = 10;
const TROPHY_THRESHOLD = 3.0;

// Note: The structure has changed since previous assignments because we need to handle the 
// async methods used for setting up XR. In particular, "createDefaultXRExperienceAsync" 
// needs to load models and create various things.  So, the function returns a promise, 
// which allows you to do other things while it runs.  Because we don't want to continue
// executing until it finishes, we use "await" to wait for the promise to finish. However,
// await can only run inside async functions. https://javascript.info/async-await
class Game 
{ 
    private canvas: HTMLCanvasElement;
    private engine: Engine;
    private scene: Scene;
    private xrCamera: WebXRCamera | null = null;
    private ballCollider: AbstractMesh | null = null;
    private controllerRight: WebXRInputSource | null;
    private controllerLeft: WebXRInputSource | null;
    private controllerPhysics: WebXRControllerPhysics | null;
    private highlightLayer: HighlightLayer | null;

    private score: number;
    private trophies: AbstractMesh[];
    private doors: AbstractMesh[];
    private collectionSound: Sound | null;
    private compassMesh: AbstractMesh | null;


    constructor()
    {
        // Get the canvas element 
        this.canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

        // Generate the BABYLON 3D engine
        this.engine = new Engine(this.canvas, true); 

        // Creates a basic Babylon Scene object
        this.scene = new Scene(this.engine);   

        this.highlightLayer = new HighlightLayer("highlightLayer", this.scene);

        this.controllerRight = null;
        this.controllerLeft = null;
        this.controllerPhysics = null;
        
        this.score = 0;
        this.trophies = [];
        this.doors = [];
        this.compassMesh = null;

        this.collectionSound = null;
    }

    start() : void
    {
        this.createScene().then(() => {
            // Register a render loop to repeatedly render the scene
            this.engine.runRenderLoop(() => { 
                this.update();
                this.scene.render();
            });

            // Watch for browser/canvas resize events
            window.addEventListener("resize", () => { 
                this.engine.resize();
            });
        });
    }

    private async createScene() {

        var canvasCamera = new UniversalCamera("debug camera", new Vector3(0, 7, 0), this.scene);
        canvasCamera.fov = 90 * Math.PI / 180;

        // This attaches the camera to the canvas
        canvasCamera.attachControl(this.canvas, true);

        var light = new HemisphericLight ("light", new Vector3 (0.8,1,1), this.scene);
        light.intensity = 0.70;

        // gravity and physics (The return of Ammo)
        const ImportedAmmo = await ammo.call({});
        this.scene.enablePhysics(new Vector3(0, -5.81, 0), new AmmoJSPlugin(true, ImportedAmmo));
        

        //Initalize Ball
        const ball = await SceneLoader.ImportMeshAsync("", "./assets/meshes/", "ball.glb");
        const ballMaterial = new StandardMaterial("ballMat");
        ballMaterial.diffuseTexture = new Texture("./assets/meshes/BallMaterial.png", this.scene, true, false);
        ballMaterial.bumpTexture = new Texture("./assets/meshes/BallNormal.png", this.scene, true, false);
        ballMaterial.alpha = 0.2;
        var mesh = ball.meshes[0].getChildMeshes()[0];
        mesh.parent = null;
        mesh.position = new Vector3(0, 50, 5);
        mesh.scaling = new Vector3(2,2,2);
        mesh.material = ballMaterial;
        mesh.physicsImpostor = new PhysicsImpostor(mesh, PhysicsImpostor.SphereImpostor, {friction: 15, mass: 11}, this.scene);
        mesh.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
        mesh.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
        this.ballCollider = mesh;

        // There is a bug in Babylon 4.1 that fails to enable the highlight layer on the Oculus Quest. 
        // This workaround fixes the problem.
        var canvasOptions = WebXRManagedOutputCanvasOptions.GetDefaults();
        canvasOptions.canvasOptions!.stencil = true;

        // Creates the XR experience helper
        const xrHelper = await this.scene.createDefaultXRExperienceAsync({outputCanvasOptions: canvasOptions});

        //VR camera
        this.xrCamera = xrHelper.baseExperience.camera;
        this.xrCamera.fov = 90 * Math.PI / 180;

        // There is a bug in Babylon 4.1 that fails to reenable pointer selection after a teleport
        // This is a hacky workaround that disables a different unused feature instead
        xrHelper.teleportation.setSelectionFeature(xrHelper.baseExperience.featuresManager.getEnabledFeature("xr-background-remover"));

        // Register event handler for selection events (pulling the trigger, clicking the mouse button)
        this.scene.onPointerObservable.add((pointerInfo) => {
            this.processPointer(pointerInfo);
        });

        // Register event handler when controllers are added
        xrHelper.input.onControllerAddedObservable.add((controller) => {
            if(controller.uniqueId.includes("left")) {
                this.controllerLeft = controller;
            } else if(controller.uniqueId.includes("right")) {
                this.controllerRight = controller;
            } else {
                console.log("Handling potential Vive Tracker by simply ignoring it.");
            }
            this.controllerPhysics = xrHelper.baseExperience.featuresManager.enableFeature(WebXRControllerPhysics.Name, 'latest', { xrInput: xrHelper.input }) as WebXRControllerPhysics;
            this.controllerPhysics.getImpostorForController(controller)?.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(1);
            this.controllerPhysics.getImpostorForController(controller)?.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(1);
            this.onControllerAdded(controller);
        });

        // Register event handler when controllers are removed
        xrHelper.input.onControllerRemovedObservable.add((controller) => {
            this.onControllerRemoved(controller);
        });

        xrHelper.pointerSelection.displayLaserPointer = false;
        xrHelper.pointerSelection.displaySelectionMesh = false;

        var transform = new TransformNode("root"); 

        const whiteMaterial = new StandardMaterial("whiteMat");
        whiteMaterial.diffuseColor = new Color3(1, 1, 1);
        whiteMaterial.ambientColor = new Color3(1, 1, 1);
        whiteMaterial.specularColor = new Color3(0.1, 0.1, 0.1);
        whiteMaterial.specularPower = 30;
        whiteMaterial.emissiveColor = new Color3(0.3, 0.3, 0.3);

        const blueMaterial = new StandardMaterial("blueMat");
        blueMaterial.diffuseColor = Color3.Blue();

        const greenMaterial = new StandardMaterial("greenMat");
        greenMaterial.diffuseColor = Color3.Green();

        const yellowMaterial = new StandardMaterial("yellowMat");
        yellowMaterial.diffuseColor = Color3.Yellow();
        yellowMaterial.ambientColor = Color3.Yellow();
        yellowMaterial.emissiveColor = Color3.Yellow().multiply(new Color3(0.5, 0.5, 0.5));

        const redMaterial = new StandardMaterial("redMat");
        redMaterial.diffuseColor = Color3.Red();
        redMaterial.emissiveColor = new Color3(0.8, 0, 0);
        redMaterial.specularColor = Color3.Black();

        this.collectionSound = new Sound("collect", "./assets/audio/collect.mp3", this.scene, null, {
            loop: false,
            autoplay: false,
            volume: 0.6
        });

        var assetsManager = new AssetsManager (this.scene);

        // create a skybox
        const skyboxTexture = new CubeTexture("./assets/skybox/", this.scene);
        this.scene.createDefaultSkybox(skyboxTexture, true, 1000);

        // adjust camera position before every frame
        // can't just attach it to the ball as a child, otherwise it will inherit rotation
        this.scene.onBeforeRenderObservable.add(() => {
            this.xrCamera!.position = this.ballCollider!.position;
        });
        

        // === initialize assets === //
        this.createChambers(assetsManager, whiteMaterial);
        

        //initialize Chamber4 rails
        var railTask = assetsManager.addMeshTask ("chamber4 task rails", "", "./assets/meshes/", "rails.glb");
        railTask.onSuccess = (task) => {
            const childMeshes = railTask.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                if(i.parent) {
                    var parent = i.parent;
                    i.parent = null;
                    parent.dispose();
                }
                i.name = "rail";
                i.checkCollisions = false;
                i.receiveShadows = true;
                i.material = redMaterial;
                i.position = new Vector3(-17.03,-0.37,144.99);
                i.scaling = new Vector3(40,54.29,40);
                i.rotation = new Vector3(0, -1.57079633, 0);
                i.physicsImpostor = new PhysicsImpostor(i, PhysicsImpostor.MeshImpostor, {mass: 0, restitution: 0, friction: 50}, this.scene);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
            }
        }

        //initialize Chamber6 rails
        var chamber6railTask = assetsManager.addMeshTask ("chamber6 task rails", "", "./assets/meshes/", "rails2.glb");
        chamber6railTask.onSuccess = (task) => {
            const childMeshes = chamber6railTask.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                if(i.parent) {
                    var parent = i.parent;
                    i.parent = null;
                    parent.dispose();
                }
                i.name = "rail2";
                i.checkCollisions = false;
                i.receiveShadows = true;
                i.material = redMaterial;
                i.position = new Vector3(36.092,16.763,292.360);
                i.scaling = new Vector3(6.598,-4.991,4.991);
                i.rotation = new Vector3(0, Math.PI, Math.PI);
                i.physicsImpostor = new PhysicsImpostor(i, PhysicsImpostor.MeshImpostor, {mass: 0, restitution: 0, friction: 50}, this.scene);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
            }
        }

        // doors and signage
        this.createDoors();
        this.createArrows(assetsManager, redMaterial);

        //initialize can
        var canTask = assetsManager.addMeshTask ("can task", "", "./assets/meshes/props/", "can.glb");
        canTask.onSuccess = (task) => {
            const childMeshes = canTask.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                if(i.parent) {
                    var parent = i.parent;
                    i.parent = null;
                    parent.dispose();
                }
                i.name = "can";
                i.receiveShadows = true;
                i.checkCollisions = false;
                i.material = blueMaterial;
                i.position = new Vector3(67.209, 27.658, 324.585);
                i.scaling = new Vector3(3, -5, 3);
                i.rotation = new Vector3(0, -2*Math.PI, Math.PI);
                i.physicsImpostor = new PhysicsImpostor(i, PhysicsImpostor.MeshImpostor, {mass: 0, restitution: 0.9 }, this.scene);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
            }
        }

        //initialize pencil holder
        var pencilsTask = assetsManager.addMeshTask ("pencils task", "", "./assets/meshes/props/", "pencils.glb");
        pencilsTask.onSuccess = (task) => {
            const childMeshes = pencilsTask.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                if(i.parent) {
                    var parent = i.parent;
                    i.parent = null;
                    parent.dispose();
                }
                i.name = "pencils";
                i.receiveShadows = true;
                i.checkCollisions = false;
                i.material = blueMaterial;
                i.rotation = new Vector3(5.9760074,0,0);
                i.position = new Vector3(27.937, 1.776, 243.200);
                i.scaling = new Vector3(0.5, 6.811, 0.5);
                i.physicsImpostor = new PhysicsImpostor(i, PhysicsImpostor.MeshImpostor, {mass: 0, restitution: 0.9 }, this.scene);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
            }
        }

        //initialize remote
        var remoteTask = assetsManager.addMeshTask ("remote task", "", "./assets/meshes/props/", "remote.glb");
        remoteTask.onSuccess = (task) => {
            const childMeshes = remoteTask.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                if(i.parent) {
                    var parent = i.parent;
                    i.parent = null;
                    parent.dispose();
                }
                i.name = "remote";
                i.receiveShadows = true;
                i.checkCollisions = false;
                i.material = blueMaterial;
                i.rotation = new Vector3(0, -Math.PI, -0.4993526616);
                i.position = new Vector3(-52.508, 2.288, 252.499);
                i.scaling = new Vector3(0.6, -0.6, 0.6);
                i.physicsImpostor = new PhysicsImpostor(i, PhysicsImpostor.MeshImpostor, {mass: 0, restitution: 0.9 }, this.scene);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
            }
        }

        //initialize tv
        var tvTask = assetsManager.addMeshTask ("tv task", "", "./assets/meshes/props/", "tv.glb");
        tvTask.onSuccess = (task) => {
            const childMeshes = tvTask.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                if(i.parent) {
                    var parent = i.parent;
                    i.parent = null;
                    parent.dispose();
                }
                i.name = "tv";
                i.receiveShadows = true;
                i.checkCollisions = false;
                i.material = blueMaterial;
                i.rotateAround(Vector3.Zero(), Vector3.Up(), 5 * Math.PI / 3);
                i.position = new Vector3(-34, -3, 300);
                i.scaling = new Vector3(0.3, -0.3, 0.3);
                i.physicsImpostor = new PhysicsImpostor(i, PhysicsImpostor.MeshImpostor, {mass: 0, restitution: 0.9 }, this.scene);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
            }
        }

        //Initalize Ramp
        const ramp = MeshBuilder.CreateBox("chamber3 ramp", {size:3, width: 1, height: 1, depth: 1});
        const rampMaterial = new StandardMaterial("rampMat");
        ramp.position = new Vector3(-6.02,-5.91,82.88);
        ramp.scaling = new Vector3(6.60,1,25.76);
        ramp.rotation = new Vector3(0.43633231,0,0);
        ramp.physicsImpostor = new PhysicsImpostor(ramp, PhysicsImpostor.BoxImpostor, {friction: 50, mass: 0}, this.scene);
        ramp.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
        ramp.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);

        //Initalize chamber3 jump
        const jump = MeshBuilder.CreateBox("chamber3 jump", {size:3, width: 1, height: 1, depth: 1});
        jump.position = new Vector3(3.44,-1.619,95.364);
        jump.scaling = new Vector3(12.6,4.23,9.64);
        jump.rotation = new Vector3(0.41887902,Math.PI,0);
        jump.material = whiteMaterial;
        jump.physicsImpostor = new PhysicsImpostor(jump, PhysicsImpostor.BoxImpostor, {friction: 50, mass: 0}, this.scene);
        jump.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
        jump.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);

        //Initalize chamber5 jump
        const chamber5Jump = MeshBuilder.CreateBox("chamber5 jump", {size:3, width: 1, height: 1, depth: 1});
        chamber5Jump.position = new Vector3(-37.404,1.402,269.805);
        chamber5Jump.scaling = new Vector3(12.6,4.23,9.64);
        chamber5Jump.rotation = new Vector3(0.41887902,Math.PI,0);
        chamber5Jump.material = whiteMaterial;
        chamber5Jump.physicsImpostor = new PhysicsImpostor(chamber5Jump, PhysicsImpostor.BoxImpostor, {friction: 50, mass: 0}, this.scene);
        chamber5Jump.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
        chamber5Jump.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);

        //Initalize chamber5 jump #2
        const chamber5Jump2 = MeshBuilder.CreateBox("chamber5 jump", {size:3, width: 1, height: 1, depth: 1});
        chamber5Jump2.position = new Vector3(39.004,2.550,299.344);
        chamber5Jump2.scaling = new Vector3(12.6,4.23,14.812);
        chamber5Jump2.rotation = new Vector3(-0.41887902,Math.PI,0);
        chamber5Jump2.material = whiteMaterial;
        chamber5Jump2.physicsImpostor = new PhysicsImpostor(chamber5Jump2, PhysicsImpostor.BoxImpostor, {friction: 50, mass: 0}, this.scene);
        chamber5Jump2.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
        chamber5Jump2.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);

        //Initalize chamber5 physics box
        const chamber5Box = MeshBuilder.CreateBox("chamber5 box", {size:3, width: 3, height: 3, depth: 3});
        chamber5Box.position = new Vector3(39.770,10.243,302.624);
        chamber5Box.scaling = new Vector3(1,1,1);
        chamber5Box.material = greenMaterial;
        chamber5Box.physicsImpostor = new PhysicsImpostor(chamber5Box, PhysicsImpostor.BoxImpostor, {friction: 1, mass: 9, restitution: 0.5}, this.scene);
        chamber5Box.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
        chamber5Box.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);        

        //Initalize chamber5 physics sphere
        const chamber5Sphere = MeshBuilder.CreateIcoSphere("chamber5 sphere", {radius: 1.5});
        chamber5Sphere.position = new Vector3(0.146,3.099,227.300);
        chamber5Sphere.scaling = new Vector3(1,1,1);
        chamber5Sphere.material = greenMaterial;
        chamber5Sphere.physicsImpostor = new PhysicsImpostor(chamber5Sphere, PhysicsImpostor.SphereImpostor, {friction: 1, mass: 3, restitution: 0.5}, this.scene);
        chamber5Sphere.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
        chamber5Sphere.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);      

       //Initalize chamber5 big physics sphere
       const chamber5BigSphere = MeshBuilder.CreateIcoSphere("chamber5 big sphere", {radius: 6});
       chamber5BigSphere.position = new Vector3(-38.123,-4.900,326.700);
       chamber5BigSphere.scaling = new Vector3(1,1,1);
       chamber5BigSphere.material = greenMaterial;
       chamber5BigSphere.physicsImpostor = new PhysicsImpostor(chamber5BigSphere, PhysicsImpostor.SphereImpostor, {friction: 1, mass: 14, restitution: 0.5}, this.scene);
       chamber5BigSphere.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
       chamber5BigSphere.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);     

        //Initalize Chamber5 Ramp
        const chamber5Ramp = MeshBuilder.CreateBox("chamber5 ramp", {size:3, width: 1, height: 1, depth: 1});
        chamber5Ramp.position = new Vector3(54.466,11.415,282.983);
        chamber5Ramp.scaling = new Vector3(6.60,1,49.298);
        chamber5Ramp.rotation = new Vector3(0.43633231,Math.PI,0);
        chamber5Ramp.physicsImpostor = new PhysicsImpostor(chamber5Ramp, PhysicsImpostor.BoxImpostor, {friction: 50, mass: 0}, this.scene);
        chamber5Ramp.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
        chamber5Ramp.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);

        transform.scaling = new Vector3(1, 1, -1);
        transform.position = new Vector3(-1, 2.291, 342.6393);
        
        // compass
        var compassTask = assetsManager.addMeshTask("arrow task", "", "./assets/meshes/ui/", "arrow.glb");
        compassTask.onSuccess = (task) => {
            this.compassMesh = task.loadedMeshes[0];
            task.loadedMeshes[0].name = "compass arrow";
            const childMeshes = task.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                i.checkCollisions = false;
                i.material = redMaterial;
                i.rotateAround(Vector3.Zero(), Vector3.Up(), Math.PI / 2);
                i.scaling.divideInPlace(new Vector3(60, 60, 60));
            }
        }

        // trophies
        this.initTrophies(assetsManager, yellowMaterial);

        // load all assets
        assetsManager.load();

        assetsManager.onFinish = (tasks) => {
            this.scene.debugLayer.show();
        };

        // ========================= //
    }

    private update(): void {
        this.processInputs();
        this.checkTrophyCollisions();
        this.processCompass();
    }

    // collect trophies by rolling the ball into them
    // ammo has really weird collision handling, so instead we'll just check the ball's coordinates against the trophies'
    // this is expensive, but also prevents the issue of the ball stopping when colliding against a trophy
    private checkTrophyCollisions() {
        if(this.trophies.length > 0) {
            for(let trophy of this.trophies) {
                if( (this.ballCollider!.position.x >= trophy.position.x - TROPHY_THRESHOLD && this.ballCollider!.position.x <= trophy.position.x + TROPHY_THRESHOLD)
                    && (this.ballCollider!.position.y >= trophy.position.y - TROPHY_THRESHOLD && this.ballCollider!.position.y <= trophy.position.y + TROPHY_THRESHOLD)
                    && (this.ballCollider!.position.z >= trophy.position.z - TROPHY_THRESHOLD && this.ballCollider!.position.z <= trophy.position.z + TROPHY_THRESHOLD)) {
                        const index = this.trophies.indexOf(trophy);

                        if(index >= 0) {
                            this.trophies.splice(index, 1); // remove this trophy from the list
                        }
                        this.collectTrophy(trophy);
                        this.unlockNextDoor();
                    }
            }
        }
    }

    private unlockNextDoor() {
        if(this.doors.length > 0) {
            var door = this.doors[0]
            this.doors.splice(0, 1);

            door.position.y = -900; // hacky workaround for the door's physics bounds persisting after everything is disposed

            door.physicsBody?.dispose();
            door.physicsImpostor?.dispose();
            door.physicsImpostor = null;
            door.dispose();
            (door as any) = null;
        }
    }

    private processInputs(): void {
        this.onTrigger(this.controllerLeft!, this.controllerLeft?.motionController?.getComponent("xr-standard-trigger"));
        this.onAButton(this.controllerLeft!, this.controllerLeft?.motionController?.getComponent("a-button"));
        this.onTrigger(this.controllerRight!, this.controllerRight?.motionController?.getComponent("xr-standard-trigger"));
        this.onAButton(this.controllerRight!, this.controllerRight?.motionController?.getComponent("a-button"));
    }

    // Event handler for processing pointer selection events
    private processPointer(pointerInfo: PointerInfo)
    {
        switch (pointerInfo.type) {
            case PointerEventTypes.POINTERDOWN:
                if (pointerInfo.pickInfo?.hit) {
                    console.log("selected mesh: " + pointerInfo.pickInfo.pickedMesh?.name);
                }
                break;
        }

    }

    private onTrigger(controller : WebXRInputSource, trigger?: WebXRControllerComponent)
    {  
        if(trigger?.changes.pressed)
        {
            if(trigger?.pressed)
            {
                var handPhysics = this.controllerPhysics?.getImpostorForController(controller!);
                var handVelocity = handPhysics?.getLinearVelocity();
                if(handVelocity!._y > 5) {
                    handVelocity!._y = 5;
                } else if(handVelocity!._y < -5) {
                    handVelocity!._y = -5;
                }
                var rollStrength = handVelocity!._y*DRAG_SENSITIVITY;

                console.log("hand Y velocity: " + handVelocity!._y); 

                var forward = controller?.pointer.forward;

                var velocityToApply = new Vector3(-(forward!._x * rollStrength), 0.2, -(forward!._z * rollStrength));
                this.ballCollider?.physicsImpostor?.applyImpulse(velocityToApply, this.ballCollider?.absolutePosition);
                console.log("applied velocity is: " + velocityToApply);
            }
        }  
    }

    private onAButton(controller : WebXRInputSource, button?: WebXRControllerComponent) {  
        if(button?.pressed) {
            this.ballCollider?.physicsImpostor?.setAngularVelocity(Vector3.Zero());
        }  
    }

    // Event handler when controllers are added
    private onControllerAdded(controller : WebXRInputSource) {
        console.log("controller added: " + controller.pointer.name);
        

        if(this.compassMesh != null && controller.inputSource.handedness === "left") {
            controller.pointer.addChild(this.compassMesh);
        }
        
    }

    // rotate the compass to face the next trophy
    private processCompass() {
        if(this.trophies.length > 0) {
            if(this.compassMesh != null) {
                if(this.compassMesh.parent) {
                    this.compassMesh.position.y = 0.08;
                    (this.compassMesh.parent as TransformNode).lookAt(this.trophies[0].absolutePosition);
                }
            }
        } else {
            this.compassMesh?.dispose();    // get rid of it if all trophies are collected
        }
        
    }

    // Event handler when controllers are removed
    private onControllerRemoved(controller : WebXRInputSource) {
        console.log("controller removed: " + controller.pointer.name);

        if(this.compassMesh != null) {
            this.compassMesh.parent = null;
        }
        
    }

    private createDoors() {
        // no material works pretty well here; nothing else in the scene is gray
        var door1 = MeshBuilder.CreateBox("door1", {width: 10, height: 10, depth: 3});
        door1.physicsImpostor = new PhysicsImpostor(door1, PhysicsImpostor.BoxImpostor, {mass: 0, restitution: 0.9}, this.scene);
        door1.checkCollisions = true;
        door1.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
        door1.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
        door1.position = new Vector3(0, 3, 20);
        this.doors.push(door1);

        var door2 = MeshBuilder.CreateBox("door2", {width: 10, height: 10, depth: 3});
        door2.physicsImpostor = new PhysicsImpostor(door2, PhysicsImpostor.BoxImpostor, {mass: 0, restitution: 0.9}, this.scene);
        door2.checkCollisions = true;
        door2.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
        door2.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
        door2.position = new Vector3(0, 3, 64);
        this.doors.push(door2);

        var door3 = MeshBuilder.CreateBox("door3", {width: 10, height: 10, depth: 3});
        door3.physicsImpostor = new PhysicsImpostor(door3, PhysicsImpostor.BoxImpostor, {mass: 0, restitution: 0.9}, this.scene);
        door3.checkCollisions = true;
        door3.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
        door3.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
        door3.position = new Vector3(0, 3, 124);
        this.doors.push(door3);

        var door4 = MeshBuilder.CreateBox("door4", {width: 10, height: 10, depth: 3});
        door4.physicsImpostor = new PhysicsImpostor(door4, PhysicsImpostor.BoxImpostor, {mass: 0, restitution: 0.9}, this.scene);
        door4.checkCollisions = true;
        door4.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
        door4.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
        door4.position = new Vector3(0, 23, 173);
        this.doors.push(door4);

        var door5 = MeshBuilder.CreateBox("door5", {width: 10, height: 10, depth: 3});
        door5.physicsImpostor = new PhysicsImpostor(door5, PhysicsImpostor.BoxImpostor, {mass: 0, restitution: 0.9}, this.scene);
        door5.checkCollisions = true;
        door5.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
        door5.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
        door5.position = new Vector3(0, 6, 224);
        this.doors.push(door5);
    }

    private createArrows(assetsManager: AssetsManager, material: StandardMaterial) {
        // == chamber 1 == //
        var arrowTask = assetsManager.addMeshTask("arrow task", "", "./assets/meshes/ui/", "arrow.glb");
        arrowTask.onSuccess = (task) => {
            task.loadedMeshes[0].name = "arrow";
            const childMeshes = task.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                i.checkCollisions = false;
                i.material = material;
                i.rotateAround(Vector3.Zero(), Vector3.Up(), Math.PI / 2);
            }
            task.loadedMeshes[0].position = new Vector3(0, -0.3, 12);
        }

        // == chamber 2 == //
        arrowTask = assetsManager.addMeshTask("arrow task", "", "./assets/meshes/ui/", "arrow.glb");
        arrowTask.onSuccess = (task) => {
            task.loadedMeshes[0].name = "arrow";
            const childMeshes = task.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                i.checkCollisions = false;
                i.material = material;
                i.rotateAround(Vector3.Zero(), Vector3.Up(), Math.PI / 2);
                i.rotateAround(Vector3.Zero(), Vector3.Left(), Math.PI / 6);
                i.scaling.divideInPlace(new Vector3(1.3, 1.3, 1.3));
            }
            task.loadedMeshes[0].position = new Vector3(0, -3.5, 49);
        }

        // == chamber 3 == //
        arrowTask = assetsManager.addMeshTask("arrow task", "", "./assets/meshes/ui/", "arrow.glb");
        arrowTask.onSuccess = (task) => {
            task.loadedMeshes[0].name = "arrow";
            const childMeshes = task.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                i.checkCollisions = false;
                i.material = material;
                i.scaling.divideInPlace(new Vector3(2.0, 1.6, 1.6));
                i.rotateAround(Vector3.Zero(), Vector3.Up(), Math.PI / 2);
                i.rotateAround(Vector3.Zero(), Vector3.Left(), Math.PI / 8);
            }
            task.loadedMeshes[0].position = new Vector3(3, 0.5, 95);
        }

        arrowTask = assetsManager.addMeshTask("arrow task", "", "./assets/meshes/ui/", "arrow.glb");
        arrowTask.onSuccess = (task) => {
            task.loadedMeshes[0].name = "arrow";
            const childMeshes = task.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                i.checkCollisions = false;
                i.material = material;
                i.scaling.divideInPlace(new Vector3(1.6, 1.6, 2.0));
                i.rotateAround(Vector3.Zero(), Vector3.Up(), -Math.PI / 2);
                i.rotateAround(Vector3.Zero(), Vector3.Left(), -Math.PI / 7);
            }
            task.loadedMeshes[0].position = new Vector3(-6, -8.8, 90);
        } 
    }

    private createChambers(assetsManager: AssetsManager, material: StandardMaterial) {
        //initialize Chamber1
        var chamber1Task = assetsManager.addMeshTask ("chamber task 1", "", "./assets/meshes/chambers/", "chamber1.glb");
        chamber1Task.onSuccess = (task) => {
            const childMeshes = chamber1Task.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                if(i.parent) {
                    var parent = i.parent;
                    i.parent = null;
                    parent.dispose();
                }
                i.name = "chamber1";
                i.checkCollisions = false;
                i.receiveShadows = true;
                i.material = material;
                i.position = new Vector3(0,0,0);
                i.scaling.divideInPlace(new Vector3(1.4,1.4,1.4));
                i.physicsImpostor = new PhysicsImpostor(i, PhysicsImpostor.MeshImpostor, {mass: 0, restitution: 0.9, friction: 3}, this.scene);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
                i.rotation = new Vector3(0.0, 0.0, Math.PI);
            }
        }

        
        //initialize Chamber2
        var chamber2Task = assetsManager.addMeshTask ("chamber task 2", "", "./assets/meshes/chambers/", "chamber2.glb");
        chamber2Task.onSuccess = (task) => {
            const childMeshes = chamber2Task.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                if(i.parent) {
                    var parent = i.parent;
                    i.parent = null;
                    parent.dispose();
                }
                i.name = "chamber2";
                i.checkCollisions = false;
                i.receiveShadows = true;
                i.material = material;
                i.position = new Vector3(0,0,40.362);
                i.scaling.divideInPlace(new Vector3(1.4,1.4,1.4));
                i.physicsImpostor = new PhysicsImpostor(i, PhysicsImpostor.MeshImpostor, {mass: 0, restitution: 0.9, friction: 3}, this.scene);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
                i.rotation = new Vector3(Math.PI, Math.PI, 0);
            }
        }

        //initialize Chamber3
        var chamber3Task = assetsManager.addMeshTask ("chamber task 3", "", "./assets/meshes/chambers/", "chamber3.glb");
        chamber3Task.onSuccess = (task) => {
            const childMeshes = chamber3Task.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                if(i.parent) {
                    var parent = i.parent;
                    i.parent = null;
                    parent.dispose();
                }
                i.name = "chamber3";
                i.checkCollisions = false;
                i.receiveShadows = true;
                i.material = material;
                i.position = new Vector3(0,0,103.94);
                i.scaling = new Vector3 (-18.237, -19.954, -19.954);
                i.scaling.divideInPlace(new Vector3(1.4,1.4,1.4));
                i.physicsImpostor = new PhysicsImpostor(i, PhysicsImpostor.MeshImpostor, {mass: 0, restitution: 0.9, friction: 3}, this.scene);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
                i.rotation = new Vector3(Math.PI, Math.PI, 0);
            }
        }


        //initialize Chamber4
        var chamber4Task = assetsManager.addMeshTask ("chamber task 4", "", "./assets/meshes/chambers/", "chamber4.glb");
        chamber4Task.onSuccess = (task) => {
            const childMeshes = chamber4Task.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                if(i.parent) {
                    var parent = i.parent;
                    i.parent = null;
                    parent.dispose();
                }
                i.name = "chamber4";
                i.checkCollisions = false;
                i.receiveShadows = true;
                i.material = material;
                i.position = new Vector3(0,0,141.421);
                i.scaling.divideInPlace(new Vector3(1.4,1.4,1.4));
                i.physicsImpostor = new PhysicsImpostor(i, PhysicsImpostor.MeshImpostor, {mass: 0, restitution: 0.9, friction: 3}, this.scene);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
                i.rotation = new Vector3(Math.PI, Math.PI, 0);
            }
        }

        //initialize Chamber5
        var chamber5Task = assetsManager.addMeshTask ("chamber task 5", "", "./assets/meshes/chambers/", "chamber5.glb");
        chamber5Task.onSuccess = (task) => {
            const childMeshes = chamber5Task.loadedMeshes[0].getChildMeshes();
            for(let i of childMeshes) {
                if(i.parent) {
                    var parent = i.parent;
                    i.parent = null;
                    parent.dispose();
                }
                i.name = "chamber5";
                i.checkCollisions = false;
                i.receiveShadows = true;
                i.material = material;
                i.position = new Vector3(0,19.146,192.74);
                i.scaling.divideInPlace(new Vector3(1.4,1.4,1.4));
                i.physicsImpostor = new PhysicsImpostor(i, PhysicsImpostor.MeshImpostor, {mass: 0, restitution: 0.9, friction: 3}, this.scene);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
                i.physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
                i.rotation = new Vector3(Math.PI, Math.PI, 0);
            }
        }

        //initialize Chamber6
        var chamber6Task = assetsManager.addMeshTask ("chamber task 6", "", "./assets/meshes/chambers/", "chamber6.glb");
        chamber6Task.onSuccess = (task) => {
            const childMeshes = chamber6Task.loadedMeshes[0].getChildMeshes();
            var parent = childMeshes[0].parent;
            childMeshes[0].parent = null;
            parent?.dispose();
            childMeshes[0].name = "chamber6";
            childMeshes[0].checkCollisions = false;
            childMeshes[0].receiveShadows = true;
            childMeshes[0].material = material;
            childMeshes[0].position = new Vector3(0,1.6,281.24);
            childMeshes[0].scaling = new Vector3(-40.725, -40.725, 40.725);
            childMeshes[0].physicsImpostor = new PhysicsImpostor(childMeshes[0], PhysicsImpostor.MeshImpostor, {mass: 0, restitution: 0.9, friction: 3}, this.scene);
            childMeshes[0].physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterMask(2);
            childMeshes[0].physicsImpostor.physicsBody.getBroadphaseProxy().set_m_collisionFilterGroup(2);
            childMeshes[0].rotation = new Vector3(Math.PI, 0, 0);
        }
    }


    private initTrophies(assetsManager: AssetsManager, material: StandardMaterial) {
        var trophyTask = assetsManager.addMeshTask("trophy task", "", "./assets/meshes/collectables/", "trophy.glb");
        trophyTask.onSuccess = (task) => this.trophyTaskCallback(task, new Vector3(10, 2, -8), material);

        trophyTask = assetsManager.addMeshTask("trophy task", "", "./assets/meshes/collectables/", "trophy.glb");
        trophyTask.onSuccess = (task) => this.trophyTaskCallback(task, new Vector3(0, 2, 58), material);

        trophyTask = assetsManager.addMeshTask("trophy task", "", "./assets/meshes/collectables/", "trophy.glb");
        trophyTask.onSuccess = (task) => this.trophyTaskCallback(task, new Vector3(0, 1.4, 120), material);

        trophyTask = assetsManager.addMeshTask("trophy task", "", "./assets/meshes/collectables/", "trophy.glb");
        trophyTask.onSuccess = (task) => this.trophyTaskCallback(task, new Vector3(6, 20.4, 165), material);

        trophyTask = assetsManager.addMeshTask("trophy task", "", "./assets/meshes/collectables/", "trophy.glb");
        trophyTask.onSuccess = (task) => this.trophyTaskCallback(task, new Vector3(0, 6, 218), material);
    }

    private trophyTaskCallback(task: MeshAssetTask, position: Vector3, material: StandardMaterial) {
        task.loadedMeshes[0].name = "trophy";
        task.loadedMeshes[0].receiveShadows = true;
        const childMeshes = task.loadedMeshes[0].getChildMeshes();
        for(let i of childMeshes) {
            i.checkCollisions = false;
            i.scaling.divideInPlace(new Vector3(1.4,1.4,1.4));
            i.material = material;
            this.highlightLayer?.addMesh((i as Mesh), Color3.Yellow());
        }
        this.trophies.push(task.loadedMeshes[0]);
        task.loadedMeshes[0].position = position;
        const shimmerSound = new Sound("trophy shimmer", "./assets/audio/shimmer.mp3", this.scene, null, {
            loop: true,
            autoplay: true,
            spatialSound: true,
            maxDistance: 30
        })
        shimmerSound.setPosition(position);
    }

    // collect a trophy
    private collectTrophy(trophy: AbstractMesh) {
        trophy.dispose();
        this.score++;
        this.collectionSound?.play();
    }

}
/******* End of the Game class ******/   

// Start the game
var game = new Game();
game.start();
