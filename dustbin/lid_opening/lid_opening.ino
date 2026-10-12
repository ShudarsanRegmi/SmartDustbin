#include <Servo.h>

Servo myservo;

int controlPin = 7;   // input pin (button / sensor)
int servoPin = 9;     // servo signal pin

void setup() {
  myservo.attach(servoPin);

  // Use internal pull-up to avoid floating issue
  pinMode(controlPin, INPUT_PULLUP);

  // Initial position (lid closed)
  myservo.write(0);
}

void loop() {
  int state = digitalRead(controlPin);

  if (state == LOW) {
    // Triggered (button pressed / sensor active)
    myservo.write(210);   // open lid
  } else {
    // Default state
    myservo.write(0);     // close lid  
  }

  delay(50); // small delay for stability
}