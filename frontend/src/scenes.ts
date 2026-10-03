// The two three.js views: the robot drawn from its own encoders (pose) and the MID360 point cloud (lidar). Both are
// imperative; the React side creates them on a canvas and feeds them data. Colors are theme tokens, re-read on `dim-theme`.
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { JOINTS } from "./joints.ts"

const colorProbe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!

function tokenColor(name: string) {
    colorProbe.clearRect(0, 0, 1, 1)
    colorProbe.fillStyle = getComputedStyle(document.body).getPropertyValue(name).trim()
    colorProbe.fillRect(0, 0, 1, 1)
    const [r, g, b] = colorProbe.getImageData(0, 0, 1, 1).data
    return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace)
}

function themedGrid(size: number, divisions: number) {
    const grid = new THREE.GridHelper(size, divisions, tokenColor("--input"), tokenColor("--border"))
    grid.rotation.x = Math.PI / 2 // GridHelper is xz by default; lay it in xy
    return grid
}

function fit(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    const box = canvas.getBoundingClientRect()
    if (box.width < 2 || box.height < 2) {
        return
    }
    renderer.setSize(box.width, box.height, false)
    camera.aspect = box.width / box.height
    camera.updateProjectionMatrix()
}

/** The robot as a jointed skeleton (dimos's g1.urdf ships no meshes), posed from encoder angles + IMU roll/pitch. */
export function createPoseScene(canvas: HTMLCanvasElement) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 20)
    // three-quarter view from slightly above chest height: front-on hides hip yaw and elbow bend
    camera.up.set(0, 0, 1)
    camera.position.set(1.45, -1.45, 1.15)
    camera.lookAt(0, 0, 0.6)
    const segment = new THREE.LineBasicMaterial()
    const jointDot = new THREE.MeshBasicMaterial()
    const root = new THREE.Group()
    scene.add(root)

    // one group per link, parented as the URDF says: posing is one rotation per revolute joint
    const nodes = new Map<string, THREE.Group>()
    const bones: { node: THREE.Group; axis: THREE.Vector3; i: number }[] = []
    const linkOf = (name: string) => {
        if (!nodes.has(name)) {
            nodes.set(name, new THREE.Group())
        }
        return nodes.get(name)!
    }
    // sensor and cosmetic frames are not body: drawn, the mid360 mount alone throws a 1.2 m spike out of the chest
    const NON_STRUCTURAL = /imu_in_|logo_|d435_|mid360_/
    let revolute = 0
    for (const j of JOINTS) {
        const parent = linkOf(j.p)
        const child = linkOf(j.c)
        const hinge = new THREE.Group()
        hinge.position.set(j.xyz[0], j.xyz[1], j.xyz[2])
        hinge.rotation.set(j.rpy[0], j.rpy[1], j.rpy[2], "ZYX")
        hinge.add(child)
        parent.add(hinge)
        if (j.t === "r") {
            bones.push({
                node: child,
                axis: new THREE.Vector3(j.axis[0], j.axis[1], j.axis[2]).normalize(),
                i: revolute++,
            })
            child.add(new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), jointDot))
        }
        if (!NON_STRUCTURAL.test(j.n) && Math.hypot(j.xyz[0], j.xyz[1], j.xyz[2]) > 0.02) {
            const geometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(),
                new THREE.Vector3(j.xyz[0], j.xyz[1], j.xyz[2]),
            ])
            parent.add(new THREE.Line(geometry, segment))
        }
    }
    root.add(nodes.get(JOINTS[0].p)!)
    // the URDF's root is the pelvis: lift the zero pose so the feet stand ON the grid
    root.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(root)
    const standHeight = Number.isFinite(bounds.min.z) ? -bounds.min.z : 0.79
    root.position.z = standHeight

    let grid: THREE.GridHelper | null = null
    let q: number[] | null = null
    let rpy: number[] | null = null

    const render = () => {
        if (q) {
            for (const bone of bones) {
                if (typeof q[bone.i] === "number") {
                    bone.node.setRotationFromAxisAngle(bone.axis, q[bone.i])
                }
            }
        }
        // IMU roll and pitch tilt the body; yaw is left out so the view doesn't spin while the robot turns
        if (rpy) {
            root.rotation.set(rpy[0], rpy[1], 0, "ZYX")
        }
        renderer.render(scene, camera)
    }
    const theme = () => {
        segment.color.copy(tokenColor("--muted-fg"))
        jointDot.color.copy(tokenColor("--primary"))
        if (grid) {
            scene.remove(grid)
            grid.dispose()
        }
        grid = themedGrid(1.6, 8)
        scene.add(grid)
        render()
    }
    const resize = () => {
        fit(renderer, camera, canvas)
        render()
    }
    addEventListener("dim-theme", theme)
    addEventListener("resize", resize)
    theme()
    resize()
    return {
        update(nextQ: number[] | null, nextRpy: number[] | null) {
            q = nextQ ?? q
            rpy = nextRpy ?? rpy
            render()
        },
        resize,
        dispose() {
            removeEventListener("dim-theme", theme)
            removeEventListener("resize", resize)
            renderer.dispose()
        },
    }
}

const MAX_POINTS = 30000

/** The MID360 cloud, colored by height (--primary low → --info high), orbitable. */
export function createLidarScene(canvas: HTMLCanvasElement) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200)
    camera.up.set(0, 0, 1) // z-up to match the robot frame
    camera.position.set(-3.4, -3.4, 2.6)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.12
    controls.target.set(0, 0, 0.4)

    const markerMaterial = new THREE.MeshBasicMaterial()
    const marker = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 4), markerMaterial)
    marker.rotation.x = Math.PI / 2
    marker.position.z = 0.25
    scene.add(marker)

    const geometry = new THREE.BufferGeometry()
    const positions = new Float32Array(MAX_POINTS * 3)
    const colors = new Float32Array(MAX_POINTS * 3)
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3))
    geometry.setDrawRange(0, 0)
    scene.add(
        new THREE.Points(
            geometry,
            new THREE.PointsMaterial({ size: 0.035, vertexColors: true, sizeAttenuation: true }),
        ),
    )

    let low = new THREE.Color()
    let high = new THREE.Color()
    let grid: THREE.GridHelper | null = null
    const theme = () => {
        markerMaterial.color.copy(tokenColor("--info"))
        low = tokenColor("--primary")
        high = tokenColor("--info")
        if (grid) {
            scene.remove(grid)
            grid.dispose()
        }
        grid = themedGrid(16, 16)
        scene.add(grid)
    }
    const resize = () => fit(renderer, camera, canvas)
    let frame = 0
    const loop = () => {
        controls.update()
        renderer.render(scene, camera)
        frame = requestAnimationFrame(loop)
    }
    addEventListener("dim-theme", theme)
    addEventListener("resize", resize)
    theme()
    resize()
    frame = requestAnimationFrame(loop)
    return {
        update(flat: number[]) {
            const n = Math.min((flat.length / 3) | 0, MAX_POINTS)
            for (let i = 0; i < n; i++) {
                const z = flat[i * 3 + 2]
                positions.set([flat[i * 3], flat[i * 3 + 1], z], i * 3)
                const t = Math.max(0, Math.min(1, (z + 0.5) / 2.5))
                colors.set(
                    [low.r + (high.r - low.r) * t, low.g + (high.g - low.g) * t, low.b + (high.b - low.b) * t],
                    i * 3,
                )
            }
            geometry.attributes.position.needsUpdate = true
            geometry.attributes.color.needsUpdate = true
            geometry.setDrawRange(0, n)
        },
        resize,
        dispose() {
            cancelAnimationFrame(frame)
            removeEventListener("dim-theme", theme)
            removeEventListener("resize", resize)
            controls.dispose()
            renderer.dispose()
        },
    }
}
