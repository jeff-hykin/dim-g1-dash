// The robot drawn from its own encoders: a jointed skeleton (dimos's g1.urdf ships no meshes), posed from the encoder
// angles + IMU roll/pitch, as a layer of a dimos-react Scene3D. Colors are theme tokens, re-read on a theme change.
import { useEffect } from "react"
import * as THREE from "three"
import { cssColor, useLayer, useViewer } from "dimos-react/three"
import { JOINTS } from "./joints.ts"

// sensor and cosmetic frames are not body: drawn, the mid360 mount alone throws a 1.2 m spike out of the chest
const NON_STRUCTURAL = /imu_in_|logo_|d435_|mid360_/

type SkeletonLayer = {
    root: THREE.Group
    pose(q: number[] | null, rpy: number[] | null): void
    dispose(): void
}

function createSkeleton(): SkeletonLayer {
    const segment = new THREE.LineBasicMaterial()
    const jointDot = new THREE.MeshBasicMaterial()
    const root = new THREE.Group()
    // one group per link, parented as the URDF says: posing is one rotation per revolute joint
    const nodes = new Map<string, THREE.Group>()
    const bones: { node: THREE.Group; axis: THREE.Vector3; i: number }[] = []
    const linkOf = (name: string) => {
        if (!nodes.has(name)) {
            nodes.set(name, new THREE.Group())
        }
        return nodes.get(name)!
    }
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
    root.position.z = Number.isFinite(bounds.min.z) ? -bounds.min.z : 0.79
    const theme = () => {
        segment.color.copy(cssColor("var(--muted-fg)"))
        jointDot.color.copy(cssColor("var(--primary)"))
    }
    theme()
    addEventListener("dimos-react-theme", theme)
    return {
        root,
        pose(q, rpy) {
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
        },
        dispose() {
            removeEventListener("dimos-react-theme", theme)
            root.traverse((object) => (object as THREE.Mesh).geometry?.dispose())
            segment.dispose()
            jointDot.dispose()
        },
    }
}

/** The G1 skeleton at the scene's origin, posed from `positions` (encoder angles, rad) and `rpy` (IMU, rad). */
export function Skeleton({ positions, rpy }: { positions: number[] | null; rpy: number[] | null }) {
    const viewer = useViewer()
    const layer = useLayer(() => createSkeleton(), [])
    useEffect(() => {
        layer.current?.pose(positions, rpy)
        viewer?.requestRender()
    }, [viewer, positions, rpy?.join(",")])
    return null
}
