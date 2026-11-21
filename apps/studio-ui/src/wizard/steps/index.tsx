import type { ComponentType } from "react";

import { EntryStep } from "./EntryStep";
import { LootStep, MonumentsStep, PathsStep, TerrainStep, ValidateStep } from "./WorldSteps";
import { BaseItemStep, MaterialsStep, PaintStep, WearStep, WorkshopStep } from "./SkinSteps";
import type { WizardStepId } from "../types";

export const STEP_COMPONENTS: Record<WizardStepId, ComponentType> = {
  entry: EntryStep,
  terrain: TerrainStep,
  monuments: MonumentsStep,
  paths: PathsStep,
  loot: LootStep,
  validate: ValidateStep,
  baseItem: BaseItemStep,
  materials: MaterialsStep,
  paint: PaintStep,
  wear: WearStep,
  workshop: WorkshopStep,
};
