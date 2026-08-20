"""
Typed models for the two JSON schemas this pipeline deals with:

- Environment: the input scene description. All fields observed across the
  example environments (clock, coordinates, world, entities, targets,
  evaluation) are typed, including the static-vs-keyframe-animated
  transform variant and the box-vs-sphere bounds variant. extra="allow" is
  kept everywhere as a safety net for fields not yet seen.
- CameraTrajectory: the output schema. This one is strict (no extra fields,
  every field explicitly required-or-nullable) because it doubles as the
  JSON Schema sent to OpenRouter's structured-output mode — the shape here
  IS the contract the LLM is constrained to.
"""

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from pydantic import field_validator

# ---------------------------------------------------------------------------
# Environment (input) — permissive typing on nested scene content.
# ---------------------------------------------------------------------------

class Clock(BaseModel):
    model_config = ConfigDict(extra="allow")
    durationSeconds: float
    timeDomain: Optional[str] = None
    fpsHint: Optional[float] = None


class Coordinates(BaseModel):
    model_config = ConfigDict(extra="allow")
    handedness: str
    upAxis: str
    cameraForwardAxis: str
    lengthUnit: str
    rotationOrder: str


class Evaluation(BaseModel):
    model_config = ConfigDict(extra="allow")
    distanceMetric: Optional[str] = None
    epsilon: Optional[float] = None


class OverviewCamera(BaseModel):
    model_config = ConfigDict(extra="allow")
    position: list[float]
    target: list[float]


class World(BaseModel):
    model_config = ConfigDict(extra="allow")
    background: Optional[str] = None
    overviewCamera: Optional[OverviewCamera] = None
    # ground/grid key sets aren't load-bearing for the pipeline's own logic
    # (they're rendering-only), so keep them as loose dicts rather than
    # fully modeling every key.
    ground: Optional[dict] = None
    grid: Optional[dict] = None


class Keyframe(BaseModel):
    model_config = ConfigDict(extra="allow")
    t: float
    value: list[float]


class KeyframeCurve(BaseModel):
    model_config = ConfigDict(extra="allow")
    interpolation: str
    extrapolation: str
    keyframes: list[Keyframe]


# An entity's position/rotation is either a fixed value ([x,y,z] or
# [x,y,z,w]) or an animated curve with its own keyframes.
PositionOrCurve = list[float] | KeyframeCurve


class Transform(BaseModel):
    model_config = ConfigDict(extra="allow")
    space: str
    position: PositionOrCurve
    rotation: Optional[PositionOrCurve] = None


class Visual(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: str
    name: Optional[str] = None       # for type == "preset"
    shape: Optional[str] = None      # for type == "primitive"
    params: dict = Field(default_factory=dict)
    color: Optional[str] = None


class Bounds(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: str
    # box variant
    min: Optional[list[float]] = None
    max: Optional[list[float]] = None
    # sphere variant
    center: Optional[list[float]] = None
    radius: Optional[float] = None


class Entity(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    label: Optional[str] = None
    transform: Transform
    visual: Optional[Visual] = None
    bounds: Optional[Bounds] = None


class Target(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    entityId: str
    label: Optional[str] = None
    localAnchor: list[float]
    localBounds: Optional[Bounds] = None


class Environment(BaseModel):
    """
    Fully typed for every field observed across the example environments so
    far (clock, coordinates, world, entities, targets, evaluation). extra=
    "allow" is kept at every level as a safety net for fields not yet seen
    in an example, so a genuinely new/unexpected key doesn't break loading
    — it'll just ride along untyped rather than being rejected. The full
    original JSON (not this model's dump) is still what gets sent to the
    LLM, so even an untyped/unexpected field always reaches the prompt.
    """
    model_config = ConfigDict(extra="allow")

    schemaVersion: str
    kind: Literal["environment"]
    id: str
    promptExampleId: Optional[str] = None
    prompt: str
    clock: Clock
    coordinates: Coordinates
    evaluation: Optional[Evaluation] = None
    world: Optional[World] = None
    entities: list[Entity] = Field(default_factory=list)
    targets: list[Target] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# CameraTrajectory (output) — strict typing, doubles as the structured-output
# JSON Schema sent to OpenRouter.
# ---------------------------------------------------------------------------

class TrajectoryClock(BaseModel):
    model_config = ConfigDict(extra="forbid")
    durationSeconds: float
    timeUnit: Literal["second"]


class TrajectoryCoordinates(BaseModel):
    model_config = ConfigDict(extra="forbid")
    handedness: Literal["right", "left"]
    upAxis: str
    cameraForwardAxis: str
    lengthUnit: str
    rotationOrder: str


class Intrinsics(BaseModel):
    model_config = ConfigDict(extra="forbid")
    projection: Literal["perspective"]
    fovYDegrees: float
    near: float
    far: float


class Orientation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["perSampleLookAt"]
    up: list[float]

    @field_validator("up")
    @classmethod
    def validate_up(cls, v):
        if len(v) != 3:
            raise ValueError("up must contain exactly 3 values")
        return v


class TrajectoryRateSegment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    startTime: float
    endTime: float
    rate: float
    label: Optional[str]


class TrajectoryPlayback(BaseModel):
    """
    Optional time-treatment directive for the shot: a piecewise mapping of
    how world/scene time progresses relative to playback time. rate=0 over
    a segment means world time is frozen for that stretch of playback time
    (the camera can still move through space; this is how "freeze time",
    "stop motion", and "hold the frame" directions are encoded). rate=1 is
    normal speed; other values speed up/slow down world time relative to
    playback (slow motion, speed ramps). Only include this when the prompt
    actually calls for such an effect — omit (set playback to null) for an
    ordinary shot with no time manipulation.
    """
    model_config = ConfigDict(extra="forbid")
    rateSegments: list[TrajectoryRateSegment]


class Sample(BaseModel):
    model_config = ConfigDict(extra="forbid")
    t: float
    position: list[float]
    lookAt: list[float]
    # Nullable-but-required (not Python-optional-with-default): strict JSON
    # Schema mode requires every key to be present in "required", so these
    # must be explicitly settable to null rather than omitted.
    fovYDegrees: Optional[float]
    actionId: Optional[str]

    @field_validator("position")
    @classmethod
    def validate_position(cls, v):
        if len(v) != 3:
            raise ValueError("position must have exactly 3 values")
        return v

    @field_validator("lookAt")
    @classmethod
    def validate_lookat(cls, v):
        if len(v) != 3:
            raise ValueError("lookAt must have exactly 3 values")
        return v


class CameraTrajectory(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: str
    kind: Literal["cameraTrajectory"]
    environmentId: str
    clock: TrajectoryClock
    coordinates: TrajectoryCoordinates
    intrinsics: Intrinsics
    orientation: Orientation
    # Nullable-but-required, same reasoning as Sample's optional fields above.
    playback: Optional[TrajectoryPlayback]
    samples: list[Sample]


def camera_trajectory_response_format() -> dict:
    """
    Builds the OpenRouter `response_format` payload for structured output,
    derived directly from the CameraTrajectory model so the schema sent to
    the API can never drift from the type used to parse the response.
    """
    schema = CameraTrajectory.model_json_schema()
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "camera_trajectory",
            "strict": True,
            "schema": schema,
        },
    }
