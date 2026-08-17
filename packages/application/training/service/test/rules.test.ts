import { describe, expect, it } from "vitest"

import {
  hasExplicitRoutineApproval,
  isTrainingMutationRequest,
  trainingSafetyDecision,
  trainingSafetyResponse,
  trainingSafetySignal
} from "../src/rules.ts"

describe("Training rules", () => {
  it("stops guidance after machine confusion", () => {
    expect(
      trainingSafetyDecision({ painReported: false, injuryReported: false, machineConfusion: true })
    ).toMatchObject({ stop: true, code: "machine_confusion" })
  })

  it("uses a fixed safety response in the owner's language", () => {
    expect(trainingSafetyResponse("Mitt knä gör ont efter setet.")).toBe(
      "Avsluta övningen nu. Öka inte vikten. Be en kvalificerad tränare eller vårdpersonal om hjälp."
    )
    expect(trainingSafetyResponse("Jag förstår inte den här maskinen.")).toBe(
      "Avsluta övningen nu. Öka inte vikten. Be en kvalificerad tränare eller vårdpersonal om hjälp."
    )
    expect(trainingSafetyResponse("My knee hurts after that set.")).toBe(
      "Stop this exercise now. Do not increase the weight. Ask a qualified trainer or health professional for help."
    )
  })

  it("requires owner words for routine approval", () => {
    expect(hasExplicitRoutineApproval("Save this routine for me.")).toBe(true)
    expect(hasExplicitRoutineApproval("What routine do you suggest?")).toBe(false)
    expect(hasExplicitRoutineApproval("Do not save this routine.")).toBe(false)
    expect(hasExplicitRoutineApproval("I do not approve this workout plan.")).toBe(false)
    expect(hasExplicitRoutineApproval("Spara den här rutinen åt mig.")).toBe(true)
    expect(hasExplicitRoutineApproval("Jag godkänner träningsplanen.")).toBe(true)
    expect(hasExplicitRoutineApproval("Rutinen ser bra ut.")).toBe(true)
    expect(hasExplicitRoutineApproval("Spara inte den här rutinen.")).toBe(false)
    expect(hasExplicitRoutineApproval("Jag godkänner inte träningsplanen.")).toBe(false)
    expect(hasExplicitRoutineApproval("Är rutinen godkänd?")).toBe(false)
    expect(hasExplicitRoutineApproval("Vill du spara rutinen")).toBe(false)
  })

  it("creates proposals only from affirmative owner commands", () => {
    expect(isTrainingMutationRequest("Add this gym to my profile.")).toBe(true)
    expect(isTrainingMutationRequest("Can you add this gym?")).toBe(false)
    expect(isTrainingMutationRequest("Do not add this machine.")).toBe(false)
    expect(isTrainingMutationRequest("I don't want to start the workout.")).toBe(false)
    expect(isTrainingMutationRequest("Lägg till det här gymmet.")).toBe(true)
    expect(isTrainingMutationRequest("Starta träningspasset.")).toBe(true)
    expect(isTrainingMutationRequest("Kan du lägga till det här gymmet")).toBe(false)
    expect(isTrainingMutationRequest("Vill du starta träningspasset")).toBe(false)
    expect(isTrainingMutationRequest("Vilken maskin ska jag lägga till?")).toBe(false)
    expect(isTrainingMutationRequest("Lägg inte till den här maskinen.")).toBe(false)
    expect(isTrainingMutationRequest("Jag vill inte starta träningspasset.")).toBe(false)
  })

  it("detects safety signals from trusted owner text", () => {
    expect(trainingSafetySignal("My knee hurts after that set")).toBe("pain_or_injury")
    expect(trainingSafetySignal("I do not understand this machine")).toBe("machine_confusion")
    expect(trainingSafetySignal("Log ten reps")).toBeUndefined()
    expect(trainingSafetySignal("Mitt knä gör ont efter setet.")).toBe("pain_or_injury")
    expect(trainingSafetySignal("Jag skadade axeln under övningen.")).toBe("pain_or_injury")
    expect(trainingSafetySignal("Jag är osäker på hur jag använder maskinen.")).toBe(
      "machine_confusion"
    )
    expect(trainingSafetySignal("Jag förstår inte den här maskinen.")).toBe("machine_confusion")
    expect(trainingSafetySignal("Mitt knä gör inte ont.")).toBeUndefined()
    expect(trainingSafetySignal("Jag har ingen smärta.")).toBeUndefined()
    expect(trainingSafetySignal("Jag är inte skadad.")).toBeUndefined()
    expect(trainingSafetySignal("Jag skadade inte axeln.")).toBeUndefined()
    expect(trainingSafetySignal("Jag är inte osäker på maskinen.")).toBeUndefined()
    expect(trainingSafetySignal("I am not injured.")).toBeUndefined()
    expect(trainingSafetySignal("I am not confused by this machine.")).toBeUndefined()
  })
})
