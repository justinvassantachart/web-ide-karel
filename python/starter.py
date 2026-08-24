from karel import move, run_karel, turn_left, turn_right


def main():
    for _ in range(3):
        move()
    turn_left()
    move()
    turn_right()


if __name__ == "__main__":
    run_karel(main)
